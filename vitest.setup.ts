// React 18 act() requires the act-environment flag; without it every act call
// in the panel interaction tests warns (and the warning pollutes CI output).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export {}
