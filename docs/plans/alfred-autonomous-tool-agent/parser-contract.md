# Parser Contract

## Goal

The Alfred LLM parser must deterministically convert a raw model response into one of:

1. final speech;
2. a valid tool call;
3. a retryable parser error;
4. a terminal parser error.

This parser is load-bearing. The tool loop must not depend on ad-hoc regex behavior hidden inside `agent.ts`.

## Accepted Response Shapes

### Final speech

```json
{ "speech": "Right away, sir." }
```

### Tool call

```json
{ "tool": "bash", "command": "npm test", "cwd": "/Users/muhammadabdul/work/sandbox/frontend" }
```

## Parsing Strategy

1. Trim leading/trailing whitespace.
2. Strip complete DeepSeek-style reasoning blocks before parsing:
   - `<think>...</think>`
3. Strip Markdown code fences if the remaining content is a single fenced JSON block:
   - ```json ... ```
   - ``` ... ```
4. Try strict `JSON.parse` on the remaining content.
5. If strict parse fails, attempt to extract the first balanced top-level JSON object from the response and parse that.
6. If extraction succeeds but there is meaningful non-whitespace prose after the JSON object, keep a parser warning in diagnostics but accept the JSON.
7. Validate parsed JSON against the Alfred response schemas.

## Schema Validation

A parsed object is valid only if it matches exactly one known schema.

### Valid final speech schema

- object has `speech` string
- optional `displayText` string
- no `tool` field

### Valid tool-call schema

- object has `tool` string matching a registered tool name
- object satisfies the selected tool's argument schema
- optional execution context fields are schema-valid if present

## Failure Modes

### Retryable parser errors

The loop may ask the LLM to re-emit valid JSON once when:

- malformed JSON
- valid JSON but matches no schema
- valid JSON that matches multiple schemas
- unknown tool name
- missing required tool arguments
- invalid argument types

The corrective prompt should be short and include the schema error. Do not execute any tool for a retryable parser error.

### Terminal parser errors

After one parser retry, fail gracefully with a final response:

> "I couldn't parse my own plan cleanly, sir. Please try that again."

Also terminal:

- response is empty
- response is too large after extraction limits
- parser detects multiple competing top-level JSON objects and cannot choose safely

## Unknown Tool Handling

Unknown tool names are treated as retryable parser errors once. The retry prompt should include the registered tool names.

## Diagnostics

Every parse result should include diagnostics for history/debugging:

- raw response length
- whether `<think>` was stripped
- whether code fences were stripped
- whether balanced-object extraction was used
- schema validation error if any
- retry count

## Tests Required

- strict valid speech JSON
- strict valid tool JSON
- JSON inside fenced code block
- `<think>...</think>` before JSON
- prose before JSON
- prose after JSON
- malformed JSON → retryable
- unknown tool → retryable
- schema-invalid JSON → retryable
- repeated parser failure → terminal graceful response
