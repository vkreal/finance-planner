-- App-level encryption at rest: amount/balance columns now hold
-- "enc:v1:" AES-256-GCM ciphertext text (see server/src/schema.ts).
-- SQLite stores non-numeric text as TEXT in these columns regardless
-- of their original integer affinity, so no table rebuild is needed;
-- existing plaintext rows are encrypted in place by the server data
-- layer on first load (idempotent via the enc:v1: prefix).
SELECT 1;
