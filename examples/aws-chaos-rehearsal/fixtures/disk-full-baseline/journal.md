T+102s investigate: log appendFileSync per request, 2500-byte padding, 512KB cap, no rotation. Fix: remove verbose logging from customer path.
T+175s mitigate: replaced logRequest body with no-op. Boot-time unlink clears stale full log. Restarted target (PID 30357).
T+176s verify: 100/100 200s across two rounds, disk stays 0, sustained >=80%.
