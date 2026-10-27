/**
 * Christmas easter egg: a procedural Santa, sleigh and nine reindeer for the
 * 3D globe. Same conventions as the Enterprise in satelliteModels.js — nose
 * (Rudolph) along +Z, up along +Y, overall length ~1 so the caller's
 * constant-screen-size scaling works unchanged. Cached template, cloned
 * into the scene. Materials carry a little emissive so the team reads on
 * the night side of the planet, which is where Santa spends Christmas Eve.
 */

import * as THREE from 'three';

let santa = null;

export function getSantaTemplate() {
  if (santa) return santa;

  // Santa spends the whole night on the dark side of the planet, so every
  // material carries a strong emissive floor — otherwise the team vanishes
  // against the night texture.
  const red = new THREE.MeshLambertMaterial({ color: 0xe03030, emissive: 0x7a1414 });
  const gold = new THREE.MeshLambertMaterial({ color: 0xf6c94f, emissive: 0x9a7a1e });
  const skin = new THREE.MeshLambertMaterial({ color: 0xf1c9a5, emissive: 0x7a6452 });
  const white = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9a9a9a });
  const brown = new THREE.MeshLambertMaterial({ color: 0xb07a45, emissive: 0x6a4626 });
  const darkBrown = new THREE.MeshLambertMaterial({ color: 0x6a4424, emissive: 0x3a2412 });
  const sack = new THREE.MeshLambertMaterial({ color: 0x8a6238, emissive: 0x4a3420 });
  const nose = new THREE.MeshLambertMaterial({ color: 0xff2020, emissive: 0xff2020 });
  const rein = new THREE.LineBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.8 });

  const g = new THREE.Group();

  // ── Sleigh ──
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.07, 0.26), red);
  body.position.set(0, 0.035, -0.02);
  g.add(body);
  // High curled front
  const front = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.13, 12, 1, false, 0, Math.PI), red);
  front.rotation.z = Math.PI / 2;
  front.rotation.y = Math.PI / 2;
  front.position.set(0, 0.085, 0.11);
  g.add(front);
  // Back rest
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.05, 0.02), red);
  back.position.set(0, 0.095, -0.14);
  g.add(back);
  // Gold trim along both sides
  for (const side of [-1, 1]) {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.008, 0.27), gold);
    trim.position.set(side * 0.066, 0.07, -0.02);
    g.add(trim);
    // Runners
    const runner = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.34), gold);
    runner.position.set(side * 0.055, -0.01, 0.0);
    g.add(runner);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.02, 0.008), gold);
    strut.position.set(side * 0.055, 0.0, -0.08);
    g.add(strut);
    const strut2 = strut.clone();
    strut2.position.z = 0.06;
    g.add(strut2);
  }

  // ── Santa ──
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), red);
  torso.scale.set(1, 1.1, 0.9);
  torso.position.set(0, 0.085, -0.06);
  g.add(torso);
  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.006, 6, 18), darkBrown);
  belt.rotation.x = Math.PI / 2;
  belt.position.set(0, 0.08, -0.06);
  g.add(belt);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.028, 14, 10), skin);
  head.position.set(0, 0.15, -0.06);
  g.add(head);
  const beard = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 8), white);
  beard.scale.set(1, 1.1, 0.6);
  beard.position.set(0, 0.135, -0.04);
  g.add(beard);
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.07, 12), red);
  hat.position.set(0, 0.195, -0.065);
  hat.rotation.x = -0.35;
  g.add(hat);
  const brim = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.008, 6, 16), white);
  brim.rotation.x = Math.PI / 2;
  brim.position.set(0, 0.168, -0.06);
  g.add(brim);
  const pompom = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 6), white);
  pompom.position.set(0, 0.225, -0.085);
  g.add(pompom);

  // Sack of presents behind him
  const bag = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), sack);
  bag.scale.set(1, 0.9, 1);
  bag.position.set(0, 0.09, -0.13);
  g.add(bag);
  for (const [x, y, z, m] of [
    [-0.02, 0.135, -0.12, gold],
    [0.02, 0.13, -0.14, white],
    [0.0, 0.14, -0.15, red],
  ]) {
    const gift = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), m);
    gift.position.set(x, y, z);
    gift.rotation.set(0.3, 0.5, 0.2);
    g.add(gift);
  }

  // ── Reindeer ──
  const makeReindeer = (rudolph) => {
    const r = new THREE.Group();
    const rBody = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.036, 0.085), brown);
    rBody.position.set(0, 0.03, 0);
    r.add(rBody);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.05, 0.022), brown);
    neck.rotation.x = -0.6;
    neck.position.set(0, 0.055, 0.045);
    r.add(neck);
    const rHead = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.024, 0.04), brown);
    rHead.position.set(0, 0.078, 0.07);
    r.add(rHead);
    const snout = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), rudolph ? nose : darkBrown);
    snout.position.set(0, 0.076, 0.092);
    r.add(snout);
    for (const side of [-1, 1]) {
      const antler = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.035, 0.005), darkBrown);
      antler.position.set(side * 0.01, 0.105, 0.06);
      antler.rotation.z = side * -0.5;
      r.add(antler);
      const tine = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.018, 0.005), darkBrown);
      tine.position.set(side * 0.02, 0.115, 0.06);
      tine.rotation.z = side * 0.6;
      r.add(tine);
      for (const zz of [-0.03, 0.03]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.04, 0.008), darkBrown);
        leg.position.set(side * 0.013, 0.0, zz);
        leg.rotation.x = zz > 0 ? 0.5 : -0.5; // mid-gallop
        r.add(leg);
      }
    }
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.007, 6, 5), white);
    tail.position.set(0, 0.04, -0.045);
    r.add(tail);
    return r;
  };

  const pairs = [0.24, 0.4, 0.56, 0.72];
  const reinPoints = [];
  const hitch = new THREE.Vector3(0, 0.05, 0.14);
  for (const z of pairs) {
    for (const side of [-1, 1]) {
      const deer = makeReindeer(false);
      deer.position.set(side * 0.05, 0.005, z);
      g.add(deer);
      reinPoints.push(hitch.clone(), new THREE.Vector3(side * 0.05, 0.045, z));
    }
  }
  const rudolph = makeReindeer(true);
  rudolph.position.set(0, 0.01, 0.9);
  g.add(rudolph);
  reinPoints.push(hitch.clone(), new THREE.Vector3(0, 0.05, 0.9));
  const reins = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(reinPoints), rein);
  g.add(reins);

  // Rudolph's glow: a small additive halo sprite-ish sphere
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.02, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  halo.position.set(0, 0.086, 0.992);
  g.add(halo);

  santa = g;
  return santa;
}
