import type { CronJob } from '../../types/openclaw';
import type { StoreSet, StoreGet } from '../store-types';

export function createCronSlice(set: StoreSet, get: StoreGet) {
  return {
    cronJobs: [] as CronJob[],
    cronStatus: null as any,

    toggleCronJob: async (id: string, enabled: boolean) => {
      const { client } = get();
      if (!client) return;
      set((state) => ({
        cronJobs: state.cronJobs.map((job) =>
          job.id === id ? { ...job, enabled } : job
        ),
      }));
      try {
        await client.updateCronJob(id, { enabled });
      } catch (error) {
        console.error('[Cron] Toggle failed:', error);
        set((state) => ({
          cronJobs: state.cronJobs.map((job) =>
            job.id === id ? { ...job, enabled: !enabled } : job
          ),
          error: String(error),
        }));
      }
    },

    runCronJob: async (id: string) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.runCronJob(id);
      } catch (error) {
        set({ error: String(error) });
      }
    },

    deleteCronJob: async (id: string) => {
      const { client } = get();
      if (!client) return;
      try {
        await client.removeCronJob(id);
        set((state) => ({ cronJobs: state.cronJobs.filter((job) => job.id !== id) }));
      } catch (error) {
        set({ error: String(error) });
      }
    },

    addCronJob: async (job: Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'>) => {
      const { client } = get();
      if (!client) return null;
      try {
        const result = await client.addCronJob(job);
        if (result.ok) {
          const now = Date.now();
          const newJob: CronJob = {
            id: result.id,
            name: job.name,
            description: job.description,
            enabled: job.enabled ?? true,
            schedule: job.schedule,
            payload: job.payload,
            sessionTarget: job.sessionTarget,
            wakeMode: job.wakeMode,
            agentId: job.agentId,
            createdAtMs: now,
            updatedAtMs: now,
            state: undefined,
          };
          set((state) => ({ cronJobs: [...state.cronJobs, newJob] }));
          return result.id;
        }
        return null;
      } catch (error) {
        set({ error: String(error) });
        return null;
      }
    },

    updateCronJob: async (id: string, updates: Partial<CronJob>) => {
      const { client } = get();
      if (!client) return false;
      try {
        const result = await client.updateCronJob(id, updates);
        if (result.ok) {
          set((state) => ({
            cronJobs: state.cronJobs.map((job) =>
              job.id === id ? { ...job, ...updates, updatedAtMs: Date.now() } : job
            ),
          }));
          return true;
        }
        return false;
      } catch (error) {
        set({ error: String(error) });
        return false;
      }
    },

    getCronRuns: async (jobId: string) => {
      const { client } = get();
      if (!client) return [];
      try {
        const result = await client.getCronRuns(jobId, { limit: 5 });
        return result.runs || [];
      } catch (error) {
        console.error('[getCronRuns] Error:', error);
        return [];
      }
    },
  };
}
