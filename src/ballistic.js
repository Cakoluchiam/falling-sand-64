// The flight phase: gravity, drag and the turbulent air, for everything that
// is not yet touching anything.
//
// In its own module rather than in the frame loop for one reason: **the
// nozzle's sub-frame backdating assumes exactly the trajectory this integrates,
// and if the two ever disagree the stream tears.** That is a property worth a
// test, and a test cannot reach into the render loop.
//
// Pure over flat typed arrays. Takes the heightfield rather than importing it,
// so it stays a function of its arguments.

import { PHASE_RESTING } from './particles.js';

/**
 * Advance every airborne grain by `dt`, land whatever reaches the surface, and
 * drop whatever leaves the domain.
 *
 * Returns the volume that left by each route, for the caller's audit: `lost`
 * over the domain edge, `eaten` into a lump.
 */
export function stepBallistic(P, field, dt, o) {
  const { px, py, pz, vx, vy, vz, radius, vol, phase, live, isAgg } = P;
  const g = o.gravity;
  const dragCoef = o.dragCoef;
  const amp = o.turbAmplitude;
  const useTurb = amp > 0 && o.curl;
  const curl = o.curl;
  const tmp = o.tmp;
  const halfW = o.halfW, halfD = o.halfD;
  let lost = 0, eaten = 0;

  // Backwards, because free() swap-removes from the tail of `live`.
  for (let k = P.count - 1; k >= 0; k--) {
    const i = live[k];
    if (phase[i] === PHASE_RESTING) continue;

    let fx = 0, fy = 0, fz = 0;
    if (useTurb) {
      curl.sample(px[i], py[i], pz[i], tmp);
      fx = tmp[0] * amp; fy = tmp[1] * amp; fz = tmp[2] * amp;
    }

    // Drag is solved implicitly so it cannot go unstable for fine grains, where
    // the coefficient over radius gets large. The 1/r is what makes size
    // matter: fine grains are strongly deflected by the turbulence, clumps
    // punch through it.
    const kr = dragCoef / radius[i];
    const denom = 1 / (1 + dt * kr);
    const nvx = (vx[i] + dt * kr * fx) * denom;
    const nvy = (vy[i] + dt * (kr * fy - g)) * denom;
    const nvz = (vz[i] + dt * kr * fz) * denom;

    // ⚠ Position advances on the *average* of the two velocities, not the new
    // one. `x += v_new * dt` is a step behind: under constant acceleration it
    // overshoots by 0.5*g*dt^2 every step, and averaging makes it exact.
    //
    // It is also the trajectory the nozzle's backdating assumes, and where the
    // two disagree the stream tears. At a 0.16 s step the freshly emitted
    // ribbon ended 19 cm below the nozzle while one integrator step carried a
    // grain 31.5 cm, leaving an empty band at exactly the 12.6 cm difference;
    // the thinnest band there went from 2% of the surrounding density to 69%
    // when this changed. At the default 1/120 step neither version bands and
    // the landing speeds differ by half a percent, so this is insurance against
    // a coarse step rather than a fix for a visible defect at a fine one.
    //
    // What remains at a coarse step is the backdate ignoring drag while this
    // applies it. Second order in the step as well, so it goes the same way.
    px[i] += 0.5 * (vx[i] + nvx) * dt;
    py[i] += 0.5 * (vy[i] + nvy) * dt;
    pz[i] += 0.5 * (vz[i] + nvz) * dt;
    vx[i] = nvx; vy[i] = nvy; vz[i] = nvz;

    const r = radius[i];
    // The surface is sampled rather than assumed flat, which is the only thing
    // standing on the heightfield until M3 builds the contact solver. Grains
    // still stop dead where they meet it and will visibly interpenetrate each
    // other; that is the motivation for M3, not a bug.
    const surf = field.heightAt(px[i], pz[i]);
    if (py[i] - r <= surf) {
      py[i] = surf + r;
      vx[i] = 0; vy[i] = 0; vz[i] = 0;
      phase[i] = PHASE_RESTING;
      // Nothing may come to rest inside a lump. Grains are ballistic right up
      // to the moment they land, so a clump and the sand around it pass freely
      // through each other on the way down -- which is correct, and is why the
      // two streams need not take turns leaving the nozzle. It only becomes
      // wrong once they stop.
      if (isAgg[i]) {
        eaten += P.eatGrainsInside(i);
      } else if (P.fallingClumpContaining(i) >= 0) {
        eaten += vol[i];
        P.free(i);
      }
      continue;
    }
    if (px[i] < -halfW || px[i] > halfW || pz[i] < -halfD || pz[i] > halfD) {
      lost += vol[i];
      P.free(i);
    }
  }
  return { lost, eaten };
}
