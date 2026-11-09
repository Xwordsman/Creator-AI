import { z } from 'zod';

export const agentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(80);
export const skillKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/)
  .max(161);
const keysSchema = z
  .array(skillKeySchema)
  .max(32)
  .refine((v) => new Set(v).size === v.length);
const agentFields = {
  agentId: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1000),
  profession: z.string().trim().max(100).optional(),
  instructions: z.string().trim().min(1).max(20000),
  skillKeys: keysSchema,
  preloadSkillKeys: keysSchema.optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
};
export const agentDefinitionSchema = z.strictObject(agentFields).superRefine((v, ctx) => {
  if (v.preloadSkillKeys?.some((key) => !v.skillKeys.includes(key)))
    ctx.addIssue({
      code: 'custom',
      path: ['preloadSkillKeys'],
      message: 'Preloads must be available skills',
    });
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export const teamDefinitionSchema = z
  .strictObject({
    leadAgent: agentIdSchema,
    members: z.array(agentDefinitionSchema).min(2).max(12),
    // Structured phases are optional; imported SOPs remain instructions until reviewed.
    phases: z
      .array(
        z.strictObject({
          name: z.string().trim().min(1).max(100),
          agents: z.array(agentIdSchema).min(1).max(11),
          task: z.string().trim().min(1).max(2000),
        }),
      )
      .max(20)
      .optional(),
  })
  .superRefine((v, ctx) => {
    const ids = v.members.map((member) => member.agentId);
    if (new Set(ids).size !== ids.length || !ids.includes(v.leadAgent))
      ctx.addIssue({
        code: 'custom',
        message: 'Team needs unique members and exactly one existing lead',
      });
    for (const [index, phase] of (v.phases ?? []).entries()) {
      if (
        new Set(phase.agents).size !== phase.agents.length ||
        phase.agents.some((id) => id === v.leadAgent || !ids.includes(id))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['phases', index],
          message: 'Only unique non-lead members can be delegated',
        });
    }
  });
export const expertInputSchema = z
  .strictObject({
    name: agentFields.name,
    description: agentFields.description,
    instructions: agentFields.instructions,
    skillKeys: keysSchema,
    // A team resolves one version per key; every member inherits this binding.
    skillVersions: z.record(skillKeySchema, z.number().int().positive()).optional(),
    expertType: z.enum(['agent', 'team']).optional(),
    agentId: agentIdSchema.optional(),
    profession: agentFields.profession,
    maxTurns: agentFields.maxTurns,
    preloadSkillKeys: keysSchema.optional(),
    quickPrompts: z.array(z.string().trim().min(1).max(500)).max(6).optional(),
    defaultInitPrompt: z.string().trim().max(1000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    team: teamDefinitionSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.expertType === 'team') !== !!v.team)
      ctx.addIssue({
        code: 'custom',
        path: ['team'],
        message: 'Team definition must match expert type',
      });
    if (v.preloadSkillKeys?.some((key) => !v.skillKeys.includes(key)))
      ctx.addIssue({
        code: 'custom',
        path: ['preloadSkillKeys'],
        message: 'Preloads must be available skills',
      });
    if (Object.keys(v.skillVersions ?? {}).some((key) => !v.skillKeys.includes(key)))
      ctx.addIssue({
        code: 'custom',
        path: ['skillVersions'],
        message: 'Pinned versions must reference available skills',
      });
    if (
      v.team?.members.some((member) => member.skillKeys.some((key) => !v.skillKeys.includes(key)))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['team'],
        message: 'Member skills must be available to the team',
      });
  });
export type ExpertInput = z.infer<typeof expertInputSchema>;
export interface Expert extends ExpertInput {
  id: string;
  version: number;
  createdAt: string;
  enabled?: boolean;
  hasSourcePackage?: boolean;
}
export interface ExpertVersion extends Expert {
  restoredFrom: number | null;
}

export interface PackageFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}
export interface Skill {
  key: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  allowedTools: string[];
  document?: string;
  files?: PackageFile[];
  enabled?: boolean;
  source?: 'builtin' | 'custom' | 'imported';
  warnings?: string[];
}
export interface SkillVersion extends Skill {
  createdAt: string;
  restoredFrom: number | null;
}
export const restoreCapabilitySchema = z.strictObject({
  version: z.number().int().positive(),
  baseVersion: z.number().int().positive(),
});
export type RestoreCapabilityInput = z.infer<typeof restoreCapabilitySchema>;
export const skillInputSchema = z.strictObject({
  key: skillKeySchema,
  document: z.string().min(1).max(40000),
});
export type SkillInput = z.infer<typeof skillInputSchema>;
export const enabledSchema = z.strictObject({
  enabled: z.boolean(),
  baseVersion: z.number().int().positive(),
});
export interface PackagePreview {
  kind: 'skill' | 'expert';
  name: string;
  packageVersion: string | null;
  expert?: ExpertInput;
  skills: Skill[];
  files: PackageFile[];
  warnings: string[];
  runtimeReady: false;
}

export function expertSkillKeys(expert: ExpertInput): string[] {
  return [
    ...new Set([...expert.skillKeys, ...(expert.team?.members.flatMap((m) => m.skillKeys) ?? [])]),
  ];
}
