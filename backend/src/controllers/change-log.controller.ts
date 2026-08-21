import type { Request, Response } from 'express';
import { listChangeLog } from '../services/change-log.service.js';

export async function listChangeLogHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const entries = await listChangeLog(unitId);
  res.json({ entries });
}
