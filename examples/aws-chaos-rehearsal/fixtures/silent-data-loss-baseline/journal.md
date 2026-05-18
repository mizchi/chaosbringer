T+0s investigate: byzantine silentSuccess rule on ddb PutItem p=0.4. /verify shows writesAcked=199 ddbCount=108 lost=91
T+180s mitigate: added read-after-write w/ ConsistentRead + retry (max 5) in writeOrder. Restarted.
T+200s verify: writesAcked +104 == ddbCount +104, lost=0 stable under 50 concurrent /orders.
