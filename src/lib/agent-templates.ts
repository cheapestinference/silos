// Agent workspace templates — sourced from templates/{lang}/*.md files.
// Vite's ?raw imports inline the file content as strings at build time.
// The same .md files are COPY'd into the Docker image for VPS setup.

// --- English ---
import enSoul from '../../templates/en/SOUL.md?raw';
import enIdentity from '../../templates/en/IDENTITY.md?raw';
import enUser from '../../templates/en/USER.md?raw';
import enTools from '../../templates/en/TOOLS.md?raw';
import enBootstrap from '../../templates/en/BOOTSTRAP.md?raw';
import enAgents from '../../templates/en/AGENTS.md?raw';
import enHeartbeat from '../../templates/en/HEARTBEAT.md?raw';

// --- Spanish ---
import esSoul from '../../templates/es/SOUL.md?raw';
import esIdentity from '../../templates/es/IDENTITY.md?raw';
import esUser from '../../templates/es/USER.md?raw';
import esTools from '../../templates/es/TOOLS.md?raw';
import esBootstrap from '../../templates/es/BOOTSTRAP.md?raw';
import esAgents from '../../templates/es/AGENTS.md?raw';
import esHeartbeat from '../../templates/es/HEARTBEAT.md?raw';

// --- French ---
import frSoul from '../../templates/fr/SOUL.md?raw';
import frIdentity from '../../templates/fr/IDENTITY.md?raw';
import frUser from '../../templates/fr/USER.md?raw';
import frTools from '../../templates/fr/TOOLS.md?raw';
import frBootstrap from '../../templates/fr/BOOTSTRAP.md?raw';
import frAgents from '../../templates/fr/AGENTS.md?raw';
import frHeartbeat from '../../templates/fr/HEARTBEAT.md?raw';

// --- German ---
import deSoul from '../../templates/de/SOUL.md?raw';
import deIdentity from '../../templates/de/IDENTITY.md?raw';
import deUser from '../../templates/de/USER.md?raw';
import deTools from '../../templates/de/TOOLS.md?raw';
import deBootstrap from '../../templates/de/BOOTSTRAP.md?raw';
import deAgents from '../../templates/de/AGENTS.md?raw';
import deHeartbeat from '../../templates/de/HEARTBEAT.md?raw';

type AgentTemplates = Record<string, string>;
type LanguageTemplates = Record<string, AgentTemplates>;

const templates: LanguageTemplates = {
  en: { 'SOUL.md': enSoul, 'IDENTITY.md': enIdentity, 'USER.md': enUser, 'TOOLS.md': enTools, 'BOOTSTRAP.md': enBootstrap, 'AGENTS.md': enAgents, 'HEARTBEAT.md': enHeartbeat },
  es: { 'SOUL.md': esSoul, 'IDENTITY.md': esIdentity, 'USER.md': esUser, 'TOOLS.md': esTools, 'BOOTSTRAP.md': esBootstrap, 'AGENTS.md': esAgents, 'HEARTBEAT.md': esHeartbeat },
  fr: { 'SOUL.md': frSoul, 'IDENTITY.md': frIdentity, 'USER.md': frUser, 'TOOLS.md': frTools, 'BOOTSTRAP.md': frBootstrap, 'AGENTS.md': frAgents, 'HEARTBEAT.md': frHeartbeat },
  de: { 'SOUL.md': deSoul, 'IDENTITY.md': deIdentity, 'USER.md': deUser, 'TOOLS.md': deTools, 'BOOTSTRAP.md': deBootstrap, 'AGENTS.md': deAgents, 'HEARTBEAT.md': deHeartbeat },
};

/** Get agent templates for the given language code (falls back to 'en') */
export function getAgentTemplates(lang: string): AgentTemplates {
  const code = lang.split('-')[0].toLowerCase();
  return templates[code] || templates.en;
}

/** List of template file names */
export const TEMPLATE_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'BOOTSTRAP.md', 'AGENTS.md', 'HEARTBEAT.md'];
