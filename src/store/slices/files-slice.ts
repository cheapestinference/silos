import type { AgentConfiguration, KnowledgeFile, KnowledgeFileType } from '../../types/openclaw';
import { defaultAgentConfig, workspaceHeaders } from '../store-utils';
import type { StoreSet, StoreGet } from '../store-types';

export function createFilesSlice(set: StoreSet, get: StoreGet) {
  return {
    // Agent configuration state
    selectedAgentConfig: null as AgentConfiguration | null,
    configLoading: false,
    configSaving: false,
    configError: null as string | null,

    // Memory files
    memoryFiles: [] as Array<{ path: string; size: number; mtime: number; type?: 'file' | 'directory' }>,
    memoryContent: '',
    memoryLoading: false,

    // Workspace files
    workspaceFiles: [] as Array<{ path: string; size: number; mtime: number; type: 'file' | 'directory' }>,
    workspaceContent: '',
    workspaceLoading: false,

    loadAgentConfig: async (agentId: string) => {
      const { client } = get();
      if (!client) return;
      set({ configLoading: true, configError: null });
      try {
        const config = await client.getAgentConfig(agentId);
        if (config) {
          set({ selectedAgentConfig: config, configLoading: false });
        } else {
          set({ selectedAgentConfig: defaultAgentConfig(agentId), configLoading: false });
        }
      } catch {
        set({
          selectedAgentConfig: defaultAgentConfig(agentId),
          configLoading: false,
          configError: null,
        });
      }
    },

    saveAgentConfig: async (agentId: string, config: Partial<AgentConfiguration>) => {
      const { client, selectedAgentConfig } = get();
      if (!client) return false;
      set({ configSaving: true, configError: null });
      try {
        const result = await client.updateAgentConfig(agentId, config);
        if (result.ok && selectedAgentConfig) {
          set({
            selectedAgentConfig: {
              ...selectedAgentConfig,
              ...config,
              updatedAt: result.updatedAt,
            },
            configSaving: false,
          });
        }
        return result.ok;
      } catch (error) {
        set({ configSaving: false, configError: String(error) });
        return false;
      }
    },

    clearAgentConfig: () => {
      set({ selectedAgentConfig: null, configError: null });
    },

    uploadKnowledgeFile: async (agentId: string, file: { name: string; content: string; type?: KnowledgeFileType }) => {
      const { client, selectedAgentConfig } = get();
      if (!client) return null;
      const fileWithType = { ...file, type: file.type ?? 'text' as KnowledgeFileType };
      try {
        const result = await client.uploadKnowledgeFile(agentId, fileWithType);
        if (result.ok && selectedAgentConfig) {
          const newFile: KnowledgeFile = {
            ...fileWithType,
            id: result.id,
            createdAt: result.createdAt,
          };
          set({
            selectedAgentConfig: {
              ...selectedAgentConfig,
              knowledgeFiles: [...selectedAgentConfig.knowledgeFiles, newFile],
            },
          });
          return result.id;
        }
        return null;
      } catch (error) {
        set({ configError: String(error) });
        return null;
      }
    },

    deleteKnowledgeFile: async (agentId: string, fileId: string) => {
      const { client, selectedAgentConfig } = get();
      if (!client) return false;
      try {
        const result = await client.deleteKnowledgeFile(agentId, fileId);
        if (result.ok && selectedAgentConfig) {
          set({
            selectedAgentConfig: {
              ...selectedAgentConfig,
              knowledgeFiles: selectedAgentConfig.knowledgeFiles.filter(f => f.id !== fileId),
            },
          });
        }
        return result.ok;
      } catch (error) {
        set({ configError: String(error) });
        return false;
      }
    },

    updateKnowledgeFile: async (agentId: string, fileId: string, updates: Record<string, unknown>) => {
      const { client, selectedAgentConfig } = get();
      if (!client) return false;
      try {
        const result = await client.updateKnowledgeFile(agentId, fileId, updates);
        if (result.ok && selectedAgentConfig) {
          set({
            selectedAgentConfig: {
              ...selectedAgentConfig,
              knowledgeFiles: selectedAgentConfig.knowledgeFiles.map(f =>
                f.id === fileId ? { ...f, ...updates, updatedAt: result.updatedAt } : f
              ),
            },
          });
        }
        return result.ok;
      } catch (error) {
        set({ configError: String(error) });
        return false;
      }
    },

    // Memory file actions - uses gateway WebSocket methods
    listMemoryFiles: async (agentId: string) => {
      const { client } = get();
      if (!client) { set({ memoryFiles: [], memoryLoading: false }); return; }
      set({ memoryLoading: true });
      try {
        const result = await client.listAgentFiles(agentId);
        const files = (result?.files || []).map(f => ({
          path: f.name,
          size: f.size || 0,
          mtime: f.updatedAtMs || 0,
        }));
        set({ memoryFiles: files, memoryLoading: false });
      } catch (error) {
        console.error('[Memory] Error listing files:', error);
        set({ memoryFiles: [], memoryLoading: false });
      }
    },

    readMemoryFile: async (agentId: string, filePath: string) => {
      const fileName = filePath.split('/').pop() || filePath;
      const { client } = get();
      if (!client) { set({ memoryContent: '', memoryLoading: false }); return; }
      set({ memoryLoading: true });
      try {
        const result = await client.getAgentFile(agentId, fileName);
        const content = result?.file?.content || '';
        set({ memoryContent: content, memoryLoading: false });
      } catch (error) {
        console.error('[Memory] Error reading file:', error);
        set({ memoryContent: '', memoryLoading: false });
      }
    },

    writeMemoryFile: async (agentId: string, filePath: string, content: string) => {
      const fileName = filePath.split('/').pop() || filePath;
      const { client } = get();
      if (!client) return false;
      try {
        const result = await client.setAgentFile(agentId, fileName, content);
        return result?.ok || false;
      } catch (error) {
        console.error('[Memory] Error writing file:', error);
        return false;
      }
    },

    // Workspace file actions (HTTP API via server.js)
    listWorkspaceFiles: async (agentId: string) => {
      const { token: authToken } = get();
      set({ workspaceLoading: true });
      try {
        const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}`, {
          headers: workspaceHeaders(authToken),
        });
        const result = await response.json();
        set({ workspaceFiles: result?.files || [], workspaceLoading: false });
      } catch (error) {
        console.error('[Workspace] Error listing files:', error);
        set({ workspaceFiles: [], workspaceLoading: false });
      }
    },

    readWorkspaceFile: async (agentId: string, filePath: string) => {
      const { token: authToken } = get();
      set({ workspaceLoading: true });
      try {
        const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(filePath)}`, {
          headers: workspaceHeaders(authToken),
        });
        const result = await response.json();
        set({ workspaceContent: result?.content || '', workspaceLoading: false });
      } catch (error) {
        console.error('[Workspace] Error reading file:', error);
        set({ workspaceContent: '', workspaceLoading: false });
      }
    },

    writeWorkspaceFile: async (agentId: string, filePath: string, content: string) => {
      const { token: authToken } = get();
      try {
        const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(filePath)}`, {
          method: 'POST', headers: workspaceHeaders(authToken, true), body: JSON.stringify({ content }),
        });
        const result = await response.json();
        return result?.ok || false;
      } catch (error) {
        console.error('[Workspace] Error writing file:', error);
        return false;
      }
    },

    deleteWorkspaceFile: async (agentId: string, filePath: string) => {
      const { token: authToken } = get();
      try {
        const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(filePath)}`, {
          method: 'DELETE',
          headers: workspaceHeaders(authToken),
        });
        const result = await response.json();
        return result?.ok || false;
      } catch (error) {
        console.error('[Workspace] Error deleting file:', error);
        return false;
      }
    },

    mkdirWorkspace: async (agentId: string, dirPath: string) => {
      const { token: authToken } = get();
      try {
        const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/mkdir?path=${encodeURIComponent(dirPath)}`, {
          method: 'POST', headers: workspaceHeaders(authToken, true),
        });
        const result = await response.json();
        return result?.ok || false;
      } catch (error) {
        console.error('[Workspace] Error creating directory:', error);
        return false;
      }
    },

    renameWorkspaceFile: async (agentId: string, from: string, to: string) => {
      const { token: authToken } = get();
      try {
        const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/rename`, {
          method: 'POST', headers: workspaceHeaders(authToken, true), body: JSON.stringify({ from, to }),
        });
        const result = await response.json();
        return result?.ok || false;
      } catch (error) {
        console.error('[Workspace] Error renaming:', error);
        return false;
      }
    },

    deleteWorkspaceDir: async (agentId: string, dirPath: string) => {
      const { token: authToken } = get();
      try {
        const response = await fetch(`/api/memory/${encodeURIComponent(agentId)}/dir?path=${encodeURIComponent(dirPath)}`, {
          method: 'DELETE',
          headers: workspaceHeaders(authToken),
        });
        const result = await response.json();
        return result?.ok || false;
      } catch (error) {
        console.error('[Workspace] Error deleting directory:', error);
        return false;
      }
    },

    browseFilesystem: async (dirPath: string) => {
      const { token: authToken } = get();
      try {
        const response = await fetch(`/api/browse?path=${encodeURIComponent(dirPath)}`, { headers: workspaceHeaders(authToken) });
        if (!response.ok) return null;
        return await response.json();
      } catch (error) {
        console.error('[Browse] Error:', error);
        return null;
      }
    },
  };
}
