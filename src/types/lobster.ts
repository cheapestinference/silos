export type LobsterStepType = 'exec' | 'approve' | 'llm-task' | 'invoke' | 'unknown';

export interface LobsterStep {
  id: string;
  command: string;
  stdin?: string;
  condition?: string;
  approval?: string;
  env?: Record<string, string>;
  type: LobsterStepType;
}

export interface LobsterWorkflow {
  agentId: string;
  filename: string;
  name: string;
  args?: Record<string, { default?: string; description?: string }>;
  steps: LobsterStep[];
  raw: string;
}

export interface LobsterFileEntry {
  agentId: string;
  agentName?: string;
  filename: string;
  name: string;
  stepCount: number;
  hasApproval: boolean;
  hasLlmTask: boolean;
}

export function inferStepType(command: string, approval?: string): LobsterStepType {
  if (approval === 'required' || approval === 'optional') return 'approve';
  if (command.includes('llm-task')) return 'llm-task';
  if (command.includes('openclaw.invoke')) return 'invoke';
  if (command.startsWith('approve')) return 'approve';
  return 'exec';
}
