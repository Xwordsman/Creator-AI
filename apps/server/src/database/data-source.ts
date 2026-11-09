import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { entities } from './entities';
import { InitialSchema1793491200000 } from './migrations/1793491200000-initial-schema';
import { CapabilityCatalog1793577600000 } from './migrations/1793577600000-capability-catalog';
import { AgentRuntime1793664000000 } from './migrations/1793664000000-agent-runtime';
import { DraftContinuation1793750400000 } from './migrations/1793750400000-draft-continuation';
import { DynamicTeams1793836800000 } from './migrations/1793836800000-dynamic-teams';

import { ContentWorkflow1793923200000 } from './migrations/1793923200000-content-workflow';
import { CapabilityReuse1794009600000 } from './migrations/1794009600000-capability-reuse';
import { ContentAssistance1794096000000 } from './migrations/1794096000000-content-assistance';
import { ModelChecks1794182400000 } from './migrations/1794182400000-model-checks';

export function createDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities,
    migrations: [
      InitialSchema1793491200000,
      CapabilityCatalog1793577600000,
      AgentRuntime1793664000000,
      DraftContinuation1793750400000,
      DynamicTeams1793836800000,
      ContentWorkflow1793923200000,
      CapabilityReuse1794009600000,
      ContentAssistance1794096000000,
      ModelChecks1794182400000,
    ],
    synchronize: false,
    migrationsRun: false,
    logging: false,
    extra: { max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 },
  });
}
