/// <reference lib="webworker" />
// Builds the generated prototype meshes off the main thread: flora and stone first, then the fractal formations.
import { buildFloraSet, buildFormationSet, type ProtoSet } from './gen/meshgen/index';
import { meshTransfer } from './gen/meshgen/geo';

const send = (set: ProtoSet, last: boolean) => (self as unknown as Worker).postMessage({ set, last }, Object.values(set).flatMap(meshTransfer));

self.onmessage = () => {
  send(buildFloraSet(), false);
  send(buildFormationSet(), true);
};
