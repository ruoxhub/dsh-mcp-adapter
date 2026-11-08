import { describe, expect, it, vi } from 'vitest'
import {
  handleElicitationRequest,
  registerElicitationHandler,
  callToolPausingForElicitation,
  type UserQuestionsLike,
} from '../src/elicitation.ts'

describe('dsh-mcp-adapter elicitation', () => {
  it('declines immediately if userQuestions is not available (deadlock prevention)', async () => {
    const result = await handleElicitationRequest(
      { serverName: 'test-server' },
      {
        mode: 'form',
        message: 'Input required',
        requestedSchema: { type: 'object', properties: { key: { type: 'string' } } },
      },
    )
    expect(result).toEqual({ action: 'decline' })
  })

  it('declines immediately for url mode', async () => {
    const mockUserQuestions: UserQuestionsLike = {
      ask: vi.fn(),
    }
    const result = await handleElicitationRequest(
      { serverName: 'test-server', userQuestions: mockUserQuestions },
      { mode: 'url', url: 'https://example.com/oauth' },
    )
    expect(result).toEqual({ action: 'decline' })
    expect(mockUserQuestions.ask).not.toHaveBeenCalled()
  })

  it('returns cancel if abort signal is already triggered', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await handleElicitationRequest(
      { serverName: 'test-server' },
      { mode: 'form' },
      controller.signal,
    )
    expect(result).toEqual({ action: 'cancel' })
  })

  it('handles empty properties with confirmation question', async () => {
    const mockUserQuestions: UserQuestionsLike = {
      ask: vi.fn().mockResolvedValue({
        answers: [{ id: 'confirm', selected: ['Continue'] }],
      }),
    }
    const result = await handleElicitationRequest(
      { serverName: 'test-server', userQuestions: mockUserQuestions },
      {
        mode: 'form',
        message: 'Allow test action?',
        requestedSchema: { type: 'object', properties: {} },
      },
    )
    expect(result).toEqual({ action: 'accept', content: {} })
    expect(mockUserQuestions.ask).toHaveBeenCalledTimes(1)
  })

  it('declines if confirmation is declined', async () => {
    const mockUserQuestions: UserQuestionsLike = {
      ask: vi.fn().mockResolvedValue({
        answers: [{ id: 'confirm', selected: ['Decline'] }],
      }),
    }
    const result = await handleElicitationRequest(
      { serverName: 'test-server', userQuestions: mockUserQuestions },
      {
        mode: 'form',
        message: 'Allow test action?',
        requestedSchema: { type: 'object', properties: {} },
      },
    )
    expect(result).toEqual({ action: 'decline' })
  })

  it('converts schema properties to questions and parses answers', async () => {
    const mockUserQuestions: UserQuestionsLike = {
      ask: vi.fn().mockImplementation(async ({ questions }) => {
        expect(questions).toHaveLength(4)
        expect(questions[0].id).toBe('apiKey')
        expect(questions[1].id).toBe('port')
        expect(questions[2].id).toBe('enabled')
        expect(questions[3].id).toBe('tags')
        return {
          answers: [
            { id: 'apiKey', custom: 'secret-123' },
            { id: 'port', custom: '8080' },
            { id: 'enabled', selected: ['true'] },
            { id: 'tags', selected: ['prod', 'v1'] },
          ],
        }
      }),
    }

    const result = await handleElicitationRequest(
      { serverName: 'test-server', userQuestions: mockUserQuestions },
      {
        mode: 'form',
        message: 'Configure server parameters',
        requestedSchema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', description: 'API token' },
            port: { type: 'number', description: 'Port number' },
            enabled: { type: 'boolean', description: 'Enable feature' },
            tags: { type: 'array', description: 'Tags' },
          },
          required: ['apiKey'],
        },
      },
    )

    expect(result).toEqual({
      action: 'accept',
      content: {
        apiKey: 'secret-123',
        port: 8080,
        enabled: true,
        tags: ['prod', 'v1'],
      },
    })
  })

  it('gracefully handles userQuestions.ask() errors by declining', async () => {
    const mockUserQuestions: UserQuestionsLike = {
      ask: vi.fn().mockRejectedValue(new Error('no user-questions answerer accepted the request')),
    }

    const result = await handleElicitationRequest(
      { serverName: 'test-server', userQuestions: mockUserQuestions },
      {
        mode: 'form',
        message: 'Prompt',
        requestedSchema: {
          type: 'object',
          properties: { val: { type: 'string' } },
        },
      },
    )

    expect(result).toEqual({ action: 'decline' })
  })

  it('pauses deadline during callToolPausingForElicitation', async () => {
    let capturedHandler: ((req: any) => Promise<any>) | undefined
    const mockClient = {
      setRequestHandler: vi.fn((method, handler) => {
        if (method === 'elicitation/create') {
          capturedHandler = handler
        }
      }),
      callTool: vi.fn().mockImplementation(async () => {
        // Trigger elicitation in the middle of tool execution
        if (capturedHandler) {
          const elicitRes = await capturedHandler({ params: { mode: 'form' } })
          expect(elicitRes).toEqual({ action: 'decline' })
        }
        return { content: [{ type: 'text', text: 'ok' }] }
      }),
    } as any

    registerElicitationHandler(mockClient, {
      serverName: 'test-server',
    })

    const result = await callToolPausingForElicitation(
      mockClient,
      { name: 'test_tool', arguments: {} },
      { timeout: 1000 },
    )

    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(mockClient.callTool).toHaveBeenCalledTimes(1)
  })
})
