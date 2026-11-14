import { describe, expect, it } from 'vitest'
import * as server from './index.js'
import type { AgentRequest, RequestDecl, RequestedBy, TokenScope } from './index.js'

describe('the server entry', () => {
  it('exports what the README promises', () => {
    for (const name of ['createAgentRequestsHandlers', 'createAgentRequestsStore', 'canUseVerb', 'mintToken', 'hashToken', 'isRequestRefusal', 'RequestRefusal']) {
      expect(server, name).toHaveProperty(name)
    }
    expect(server.isRequestRefusal(new server.RequestRefusal('x'))).toBe(true)
  })
  it('exports the types', () => {
    const t: [AgentRequest?, RequestDecl?, RequestedBy?, TokenScope?] = []
    expect(t).toEqual([])
  })
})
