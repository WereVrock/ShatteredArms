// Chooses a deployment template for a team, builds the deployment zone from
// the team's spawn geometry, and produces the placement list. Stateless per
// call — one instance is reused across the whole battle by DeploymentPhase.
//
// Templates are pluggable: any object with { id, name, computePlacements }
// can be registered. Selection currently prefers an explicit id (passed by
// the caller), else the first registered template. Adding weighted selection
// over multiple viable templates later is a one-method change here, which is
// why the pick is isolated.
import { DeploymentConfig } from '../config/DeploymentConfig.js';
import { DeploymentZone } from './DeploymentZone.js';

export class DeploymentPlanner {
  constructor() {
    this._templates = [];
  }

  register(template) {
    if (!template || typeof template.computePlacements !== 'function') return;
    if (this._templates.some(t => t.id === template.id)) return;
    this._templates.push(template);
  }

  // Returns { zone, template, placements }. zone may be null if the team
  // has no living units or no axis could be derived.
  plan(teamUnits, enemyUnits, templateId) {
    const alive = teamUnits.filter(u => !u.isDefeated());
    if (alive.length === 0) {
      return { zone: null, template: null, placements: [] };
    }

    const zone = this._buildZone(alive, enemyUnits);

    const template = this._pickTemplate(templateId);
    if (!template) return { zone, template: null, placements: [] };

    const placements = template.computePlacements(alive, zone, { enemyUnits });
    return { zone, template, placements };
  }

  _pickTemplate(templateId) {
    if (templateId) {
      const found = this._templates.find(t => t.id === templateId);
      if (found) return found;
    }
    return this._templates[0] || null;
  }

_buildZone(teamUnits, enemyUnits) {
    const teamMean = meanCenter(teamUnits);
    const enemyMean = meanCenter(enemyUnits);

    let fwdX, fwdZ;
    const dx = enemyMean.x - teamMean.x;
    const dz = enemyMean.z - teamMean.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.001) {
      fwdX = dx / d;
      fwdZ = dz / d;
    } else {
      fwdX = 0;
      fwdZ = 1;
    }

    // Same right-vector convention as BattleLineFormation.getLineAxis.
    const rightX = fwdZ;
    const rightZ = -fwdX;

    // Push this team's zone center BACK along -forward so the two teams'
    // deployable areas are separated by deploymentSeparationScale × the
    // spawn distance between their mean positions. Each side contributes
    // half of the extra gap, so the zone spacing is symmetric and neither
    // team's front edge is favored. Units still spawn at their scenario
    // positions; only the rectangle they deploy inside moves.
    const extraGap = (DeploymentConfig.deploymentSeparationScale - 1) * d;
    const backOffset = extraGap / 2;
    const centerX = teamMean.x - fwdX * backOffset;
    const centerZ = teamMean.z - fwdZ * backOffset;

    const halfLateral = Math.max(
      DeploymentConfig.minHalfLateral,
      (teamUnits.length * DeploymentConfig.lateralPerUnit) / 2
    );

    return new DeploymentZone({
      centerX,
      centerZ,
      halfLateral,
      frontDepth: DeploymentConfig.frontDepth,
      backDepth: DeploymentConfig.backDepth,
      rightX,
      rightZ,
      forwardX: fwdX,
      forwardZ: fwdZ
    });
  }
}

function meanCenter(units) {
  let sx = 0, sz = 0, count = 0;
  for (const u of units) {
    if (u.isDefeated()) continue;
    const c = u.getCenter();
    sx += c.x;
    sz += c.z;
    count++;
  }
  if (count === 0) return { x: 0, z: 0 };
  return { x: sx / count, z: sz / count };
}