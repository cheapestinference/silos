// Re-export resolveSessionKey from store-utils so components can import from one place
export { resolveSessionKey } from '../store/store-utils';

// Parse session key to extract agent ID and session type
export interface ParsedSession {
  agentId: string | null;
  sessionType: 'main' | 'subagent' | 'cron' | 'webchat' | 'whatsapp' | 'slack' | 'telegram' | 'discord' | 'unknown';
  parentSessionKey?: string;
  subagentId?: string;
  cronJobId?: string;
  displayLabel: string;
}

export function parseSessionKey(sessionKey: string, agents?: { id: string }[]): ParsedSession {
  // Format: agent:{agentId}:main
  const agentMainMatch = sessionKey.match(/^agent:([^:]+):main$/);
  if (agentMainMatch) {
    return {
      agentId: agentMainMatch[1],
      sessionType: 'main',
      displayLabel: 'main'
    };
  }

  // Format: agent:{agentId}:subagent:{uuid}
  const agentSubagentMatch = sessionKey.match(/^agent:([^:]+):subagent:([^:]+)$/);
  if (agentSubagentMatch) {
    return {
      agentId: agentSubagentMatch[1],
      sessionType: 'subagent',
      subagentId: agentSubagentMatch[2],
      displayLabel: `subagent-${agentSubagentMatch[2].slice(0, 8)}`
    };
  }

  // Format: agent:{agentId}:cron:{jobId} - sessions created by cron jobs
  const agentCronMatch = sessionKey.match(/^agent:([^:]+):cron:([^:]+)$/);
  if (agentCronMatch) {
    return {
      agentId: agentCronMatch[1],
      sessionType: 'cron',
      cronJobId: agentCronMatch[2],
      displayLabel: `cron-${agentCronMatch[2].slice(0, 8)}`
    };
  }

  // Format: webchat:g-agent-{agentId} or webchat:g-agent-{agentId}-subagent-{uuid}
  const webchatMatch = sessionKey.match(/^webchat:g-agent-([^-]+(?:-[^-]+)*?)(?:-subagent-(.+))?$/);
  if (webchatMatch) {
    const potentialAgentId = webchatMatch[1];
    const subagentUuid = webchatMatch[2];

    // Try to find matching agent
    let matchedAgentId = potentialAgentId;
    if (agents) {
      const agent = agents.find(a => potentialAgentId.startsWith(a.id) || a.id.startsWith(potentialAgentId));
      if (agent) matchedAgentId = agent.id;
    }

    if (subagentUuid) {
      return {
        agentId: matchedAgentId,
        sessionType: 'subagent',
        subagentId: subagentUuid,
        displayLabel: `subagent-${subagentUuid.slice(0, 8)}`
      };
    }
    return {
      agentId: matchedAgentId,
      sessionType: 'webchat',
      displayLabel: 'webchat'
    };
  }

  // Format: whatsapp:{phoneOrGroup}:{agentId}
  const whatsappMatch = sessionKey.match(/^whatsapp:([^:]+):([^:]+)$/);
  if (whatsappMatch) {
    return {
      agentId: whatsappMatch[2],
      sessionType: 'whatsapp',
      displayLabel: `whatsapp:${whatsappMatch[1].slice(-4)}`
    };
  }

  // Format: slack:{workspace}:{channel}:{agentId}
  const slackMatch = sessionKey.match(/^slack:([^:]+):([^:]+):([^:]+)$/);
  if (slackMatch) {
    return {
      agentId: slackMatch[3],
      sessionType: 'slack',
      displayLabel: `slack:${slackMatch[2]}`
    };
  }

  // Format: telegram:{chatId}:{agentId}
  const telegramMatch = sessionKey.match(/^telegram:([^:]+):([^:]+)$/);
  if (telegramMatch) {
    return {
      agentId: telegramMatch[2],
      sessionType: 'telegram',
      displayLabel: `telegram:${telegramMatch[1].slice(-4)}`
    };
  }

  // Format: discord:{guildId}:{channelId}:{agentId}
  const discordMatch = sessionKey.match(/^discord:([^:]+):([^:]+):([^:]+)$/);
  if (discordMatch) {
    return {
      agentId: discordMatch[3],
      sessionType: 'discord',
      displayLabel: `discord:${discordMatch[2].slice(-4)}`
    };
  }

  // DM format: dm-{agentId}
  const dmMatch = sessionKey.match(/^dm-(.+)$/);
  if (dmMatch) {
    return {
      agentId: dmMatch[1],
      sessionType: 'main',
      displayLabel: 'main'
    };
  }

  // Unknown format - try to extract agent ID from any part
  if (agents) {
    for (const agent of agents) {
      if (sessionKey.includes(agent.id)) {
        return {
          agentId: agent.id,
          sessionType: 'unknown',
          displayLabel: sessionKey.split(':').pop() || sessionKey
        };
      }
    }
  }

  return {
    agentId: null,
    sessionType: 'unknown',
    displayLabel: sessionKey
  };
}

// Generate consistent color for agent based on ID
export function getAgentColor(agentId: string): string {
  const colors = [
    'bg-blue-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-rose-500',
    'bg-orange-500',
    'bg-amber-500',
    'bg-lime-500',
    'bg-emerald-500',
    'bg-teal-500',
    'bg-cyan-500',
    'bg-indigo-500',
    'bg-violet-500',
  ];

  // Simple hash function to get consistent color for same ID
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// Check if a session key represents a system/non-user session
export function isSystemSession(key: string): boolean {
  return key === 'heartbeat' || key.includes(':heartbeat') || key.includes(':health-check') || key.includes(':system:');
}
