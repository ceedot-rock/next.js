import { nextTestSetup } from 'e2e-utils'

describe('malformed-dynamic-segment', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('should return 400 for malformed percent-encoding in a dynamic segment', async () => {
    for (const slug of ['%E0%A4', '100%']) {
      const res = await next.fetch(`/items/${slug}`)
      expect(res.status).toBe(400)
    }
  })

  it('should return 200 for a valid dynamic segment', async () => {
    const res = await next.fetch('/items/hello')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('slug: hello')
  })
})
