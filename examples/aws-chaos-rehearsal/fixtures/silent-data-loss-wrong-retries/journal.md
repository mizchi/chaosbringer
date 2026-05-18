T+0s investigate: 5xx alerts but /orders returns 200. Confused.
T+90s investigate: probability sampling shows DDB PutItem returns 200. SDK retries? Yes.
T+180s mitigate: bumped writeOrder retry maxAttempts to 8, added exponential backoff.
T+240s verify: 200s still, but /verify shows lost=237 growing. Retries don't fix this.
