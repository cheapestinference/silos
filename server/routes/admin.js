import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export function createAdminRouter(gatewayToken) {
  const router = Router();

  router.post('/admin/update', async (req, res) => {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!gatewayToken || token !== gatewayToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const { stdout } = await execFileAsync('/opt/silos/self-update.sh', [], {
        timeout: 15 * 60 * 1000,
      });
      const result = JSON.parse(stdout.trim());
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
