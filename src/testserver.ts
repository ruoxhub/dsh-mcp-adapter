// The extended stdio MCP server the two cases added during the TypeScript migration drive: three
// tools, one resource, one prompt, and a tool the server marks destructive. Kept in one file so
// those checks exercise the same wire behavior.
//
// It is NOT the catalog the seven migrated end-to-end cases use. Those keep the original two-tool
// server (an inline fixture in the test file) because assertion parity with the shipped suite
// requires it: a third tool would change the tool counts those assertions pin.
//
// Newlines are joined with String.fromCharCode(10) rather than written as escapes: this source is
// itself built from lines, so nothing can be swallowed by an outer template literal before the
// server runs.

const LF = String.fromCharCode(10)

export const TEST_SERVER_SOURCE: string = [
  "import { appendFileSync } from 'node:fs';",
  "const LF = String.fromCharCode(10);",
  "const log = (line) => { try { appendFileSync(new URL('./events.log', import.meta.url), line + LF); } catch {} };",
  "const send = (message) => process.stdout.write(JSON.stringify(message) + LF);",
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  for (let at = buffer.indexOf(LF); at >= 0; at = buffer.indexOf(LF)) {",
  "    const line = buffer.slice(0, at).trim();",
  "    buffer = buffer.slice(at + 1);",
  "    if (line.length > 0) handle(JSON.parse(line));",
  "  }",
  "});",
  "function handle(message) {",
  "  if (message.id === undefined) return;",
  "  const { method, params = {} } = message;",
  "  log(method);",
  "  if (method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: {",
  "    protocolVersion: params.protocolVersion ?? '2024-11-05',",
  "    capabilities: { tools: {}, resources: {}, prompts: {} },",
  "    serverInfo: { name: 'demo', version: '1.0.0' },",
  "    instructions: 'Use ping for a health check.',",
  "  } });",
  "  if (method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [",
  "    { name: 'ping', description: 'Return the literal string pong.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },",
  "    { name: 'take_screenshot', description: 'Take a screenshot of the page or element.', inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } }, additionalProperties: false }, annotations: { readOnlyHint: true } },",
  "    { name: 'delete_widget', description: 'Delete a widget permanently.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { destructiveHint: true } },",
  "  ] } });",
  "  if (method === 'tools/call') {",
  "    const { name, arguments: args } = params;",
  "    if (name === 'ping') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } });",
  "    if (name === 'take_screenshot') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'shot ' + JSON.stringify(args) }] } });",
  "    if (name === 'delete_widget') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'deleted ' + args.id }] } });",
  "    return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true } });",
  "  }",
  "  if (method === 'resources/list') return send({ jsonrpc: '2.0', id: message.id, result: { resources: [{ uri: 'demo://readme', name: 'readme', description: 'Demo resource', mimeType: 'text/markdown' }] } });",
  "  if (method === 'resources/read') return send({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: params.uri, mimeType: 'text/markdown', text: 'readme body' }] } });",
  "  if (method === 'prompts/list') return send({ jsonrpc: '2.0', id: message.id, result: { prompts: [",
  "    { name: 'review', description: 'Review a change.', arguments: [{ name: 'target', required: true }, { name: 'mode' }] },",
  "  ] } });",
  "  if (method === 'prompts/get') return send({ jsonrpc: '2.0', id: message.id, result: { messages: [",
  "    { role: 'user', content: { type: 'text', text: 'Review ' + params.arguments.target + (params.arguments.mode ? ' in ' + params.arguments.mode : '') } },",
  "  ] } });",
  "  if (method === 'ping') return send({ jsonrpc: '2.0', id: message.id, result: {} });",
  "  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method ' + method } });",
  "}",
].join(LF) + LF
