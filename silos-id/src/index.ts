// The Worker's entry (wrangler.toml `main`): one broker per isolate, so
// Google's keys, the imported signing key and the rate limits live as long
// as the isolate does.
import { createBroker, type Env } from './broker.js'

const broker = createBroker()

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return broker.fetch(req, env)
  },
}
