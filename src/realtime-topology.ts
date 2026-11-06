export const FANOUT_SHARD_COUNT = 4;

export function fanoutShard(actorId: string): number {
  let hash = 2_166_136_261;

  for (const character of actorId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0) % FANOUT_SHARD_COUNT;
}
