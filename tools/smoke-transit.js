'use strict';
/** 临时冒烟测试：在真实北京铁路上建站、开线、跑车、结算客流 */
const { OsmDB } = require('../server/osmdb');
const { RailGraph } = require('../server/railgraph');
const { Population } = require('../server/population');
const { Transit } = require('../server/transit');

const db = new OsmDB('data/osm/osm.sqlite');
const rail = new RailGraph(db);
console.log('rail:', JSON.stringify(rail.build()));
const population = new Population(db);
const transit = new Transit(db, { rail, population });
const user = { id: 'u-smoke', name: 'SmokeCo', color: '#e6194b' };
transit.ensureCompany(user);

const rows = db.prepare(`SELECT w.id, w.node_count FROM ways w
  WHERE w.deleted = 0 AND w.tags LIKE '%"railway":"rail"%' AND w.node_count > 40
  ORDER BY w.node_count DESC LIMIT 3`).all();
const way = rows[0];
const nodes = db.prepare('SELECT node_id FROM way_nodes WHERE way_id = ? ORDER BY seq').all(way.id).map((r) => r.node_id);
const pick = (frac) => db.getNode(nodes[Math.floor(nodes.length * frac)]);
const pts = [pick(0.05), pick(0.7)].filter(Boolean);
console.log('stations at:', pts.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(' | '));

const stationIds = [];
for (let i = 0; i < pts.length; i++) {
  const res = transit.apply(user, { k: 'station.create', name: `S${i + 1}`, lat: pts[i].lat, lon: pts[i].lon, catchmentM: 900 });
  stationIds.push(res.station.id);
  console.log(`station ${res.station.name}: onRail=${res.station.onRail} pop=${res.station.catchment.pop} jobs=${res.station.catchment.jobs} cost=${res.cost}`);
}

const lineRes = transit.apply(user, { k: 'line.create', name: 'TestLine', color: '#2b8cbe', stops: stationIds });
console.log('line:', JSON.stringify({
  id: lineRes.line.id, pathLen: lineRes.line.pathLen, stops: lineRes.line.stopsInfo.length,
  dailyTrips: lineRes.line.dailyTrips, pop: lineRes.line.popTotal, jobs: lineRes.line.jobsTotal,
  travelSec: lineRes.line.travelSeconds, error: lineRes.path && lineRes.path.error,
}));

const vehRes = transit.apply(user, { k: 'vehicle.create', lineId: lineRes.line.id, cars: 4, capacityPerCar: 80, maxSpeed: 100, name: 'Train1' });
console.log('vehicle:', JSON.stringify({ id: vehRes.vehicle.id, capacity: vehRes.vehicle.capacity, cost: vehRes.cost, cash: vehRes.company.cash }));

transit.apply(user, { k: 'clock.set', speed: 20 });
console.log('clock:', JSON.stringify(transit.clockPublic()));
const samples = [];
for (let i = 0; i < 240; i++) {
  transit.tick(250);
  if (i % 60 === 0) {
    const t = transit.snapshot().trains[0];
    samples.push(t ? `${transit.clockPublic().time} load=${Math.round(t.load)} ${t.speed}km/h ${t.state}` : 'no train');
  }
}
const snap = transit.snapshot();
console.log('samples:', samples.join(' | '));
console.log('train final:', JSON.stringify(snap.trains[0]));
console.log('company:', JSON.stringify(snap.companies.find((c) => c.id === user.id)));
console.log('stats:', JSON.stringify(snap.stats));

transit.apply(user, { k: 'line.delete', id: lineRes.line.id });
for (const id of stationIds) transit.apply(user, { k: 'station.delete', id });
db.prepare('DELETE FROM companies WHERE id = ?').run(user.id);
db.prepare('DELETE FROM sim_state').run();
db.close();
console.log('cleaned up');
