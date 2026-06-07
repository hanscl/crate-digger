/**
 * Same-primary-genre scope rule shared by refill surfacing and counterfactual
 * replay. Mirrors the bucket JOIN gate (assign.ts) and MERGE gate
 * (recommendations.ts): null matches null. A candidate is only eligible to win
 * a refill slot for a bucket of the same primary genre.
 */
export function sameGenreScope(
  candidatePrimaryGenre: string | null | undefined,
  bucketPrimaryGenre: string | null,
): boolean {
  return (candidatePrimaryGenre ?? null) === bucketPrimaryGenre;
}
