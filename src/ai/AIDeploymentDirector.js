// Owns the AI's pre-battle placement decision.
//
// DeploymentPhase asks the director which template each AI-controlled team
// should use; the director returns { templateId }. This lives in the ai
// folder because it is an AI decision, not a deployment-phase detail —
// DeploymentPhase runs the phase, the director decides what the AI does
// during it. Adding a new AI deployment idea means adding a template under
// src/deployment/templates/ and a branch in decide() here. DeploymentPhase
// itself never changes.
//
// Reading the enemy roster is allowed. The AI is designed with full
// battlefield awareness (see combat-ai-non-goals in the protocols) — this
// is not a fog-of-war shortcut, it's the stated design.
//
// With one template registered, every AI team gets the standard line. The
// decision point exists so subsequent templates (refused flank, deep
// reserve, refused centre) can be chosen per-team based on roster and
// enemy composition without restructuring anything.
export class AIDeploymentDirector {
  constructor(opts = {}) {
    // Preferred fallback when decide() has no better answer — an unknown
    // teamId, a roster that fits no registered template, etc.
    this._defaultTemplateId = opts.defaultTemplateId || 'standard';
  }

  // teamUnits, enemyUnits: Unit arrays (living and dead — this method and
  // any future implementation filter as they see fit). Return shape is
  // { templateId }, matching DeploymentPlanner._pickTemplate's argument.
  //
  // The current implementation always picks the default template. When
  // additional templates exist, add conditions here. Reading rosters is
  // cheap.
  decide(teamId, teamUnits, enemyUnits) {
    return { templateId: this._defaultTemplateId };
  }
}