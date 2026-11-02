import council from './assets/avatars/council.jpg';
import designer from './assets/avatars/designer.jpg';
import explorer from './assets/avatars/explorer.jpg';
import fixer from './assets/avatars/fixer.jpg';
import observer from './assets/avatars/observer.jpg';
import oracle from './assets/avatars/oracle.jpg';
import orchestrator from './assets/avatars/orchestrator.jpg';
import type { AgentId } from './data/types';

export interface AgentMeta {
  name: string;
  role: string;
  color: string;
  avatar: string;
}

export const AGENTS: Record<AgentId, AgentMeta> = {
  orchestrator: {
    name: 'Orchestrator',
    role: 'Scheduler and integrator',
    color: '#d9a660',
    avatar: orchestrator,
  },
  oracle: {
    name: 'Oracle',
    role: 'Design review and gates',
    color: '#72a8ff',
    avatar: oracle,
  },
  fixer: {
    name: 'Fixer',
    role: 'Wiring, types and tests',
    color: '#4fd1a0',
    avatar: fixer,
  },
  designer: {
    name: 'Designer',
    role: 'Visuals and UI',
    color: '#f08bbd',
    avatar: designer,
  },
  explorer: {
    name: 'Explorer',
    role: 'Read-only scouting',
    color: '#f3a55a',
    avatar: explorer,
  },
  observer: {
    name: 'Observer',
    role: 'Visual verification',
    color: '#46cfc2',
    avatar: observer,
  },
  council: {
    name: 'Council',
    role: 'Multi-model consensus',
    color: '#ad92ff',
    avatar: council,
  },
};
