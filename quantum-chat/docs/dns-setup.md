# Quantum Chat — DNS Setup

Quantum Chat works by being the **authoritative DNS server** for a dedicated
subdomain (e.g. `qc.example.com`). You must delegate that subdomain to your node
and ensure the node is reachable on **UDP and TCP port 53** from the public
internet. This guide covers both.

> You need to own a domain and be able to edit its DNS records (at the
> registrar or wherever the parent zone is hosted).

---

## 1. Pick names and gather facts

| Thing | Example | Yours |
|---|---|---|
| Parent domain | `example.com` | |
| Quantum Chat subdomain (the delegated zone) | `qc.example.com` | |
| Nameserver hostname | `ns1.qc.example.com` | |
| Node public IPv4 | `203.0.113.10` | |

These map to `.env`: `QUANTUM_CHAT_DOMAIN`, `QUANTUM_CHAT_NS_NAMES`,
`QUANTUM_CHAT_PUBLIC_IP`.

## 2. Records to create in the PARENT zone (`example.com`)

You are delegating `qc.example.com` to your node and giving the nameserver an
address (glue):

```dns
; 1) Address (glue) record for the nameserver host
ns1.qc            IN  A   203.0.113.10

; 2) Delegate the subdomain to that nameserver
qc                IN  NS  ns1.qc.example.com.
```

Notes:
- Create the **A record first**, then the **NS delegation**.
- If your registrar manages `example.com` through its own nameservers, add both
  records in that registrar's DNS editor. The labels above are relative to
  `example.com` (`ns1.qc` → `ns1.qc.example.com`).
- For redundancy, run a second node and add `ns2.qc` (A) + a second `NS` line.

## 3. What the node answers at the apex

Once running, the node answers authoritatively for the zone apex:
- `SOA` — zone metadata (uses your admin email + nameserver).
- `NS` — the delegated nameserver name(s) from `QUANTUM_CHAT_NS_NAMES`.
- `A` — the node IP from `QUANTUM_CHAT_PUBLIC_IP`.

All message traffic uses the action subdomains under the zone (`*.s`, `*.p`,
`*.a`, `*.k`); you do **not** create records for those — the node generates them
dynamically.

## 4. Port 53 reachability (critical)

The node must receive **both** UDP and TCP on port 53:
- **UDP 53** — the normal path for queries/responses.
- **TCP 53** — used by resolvers when responses are large or truncated. Some
  resolvers retry over TCP; if it is blocked, large messages fail.

Open them in the host firewall (the installer does this with ufw) **and** in any
cloud provider security group / network ACL:

```
ufw allow 53/udp
ufw allow 53/tcp
ufw allow OpenSSH        # never lock yourself out
```

If `systemd-resolved` is bound to `:53` on the host, free the port:
```
# /etc/systemd/resolved.conf
[Resolve]
DNSStubListener=no
```
then `sudo systemctl restart systemd-resolved`.

## 5. Verify delegation and answers

From a **different** machine (so you exercise the real path):

```bash
# Authoritative SOA over UDP (the node sets the AA bit):
dig @203.0.113.10 qc.example.com SOA +norecurse

# Same over TCP (proves TCP 53 is reachable):
dig +tcp @203.0.113.10 qc.example.com SOA

# NS + A at the apex:
dig @203.0.113.10 qc.example.com NS +norecurse
dig @203.0.113.10 qc.example.com A  +norecurse

# Once the parent NS delegation has propagated, resolve WITHOUT specifying the
# server (goes through the public DNS hierarchy to your node):
dig qc.example.com SOA
```

Expected: an `ANSWER` section with your records and `flags: ... aa` on the
direct (`@node`) queries. Delegation via the public hierarchy can take minutes
to hours to propagate depending on the parent zone's TTLs.

On the node itself, the built-in probe is the quickest check:
```bash
quantum-chat health      # exit 0 = node answering locally
```

## 6. Censorship-resistance extras (optional)

- Register one or more **backup domains** and list them in
  `QUANTUM_CHAT_EXTRA_DOMAINS`; delegate each the same way. Clients rotate to a
  backup when the primary is blocked.
- Run multiple nodes on different networks/ASNs with their own NS records, or
  announce one IP via **anycast** from several PoPs.
- Distributing new domains to users when old ones are blocked needs an
  out-of-band channel — plan for that operationally.

## 7. Common pitfalls

- **Only UDP open.** Large messages and TCP-retrying resolvers fail. Open TCP 53.
- **Cloud security group still closed.** ufw is not enough on most VPS providers;
  also open 53/udp + 53/tcp in the provider console.
- **`systemd-resolved` squatting :53.** Service won't bind; see step 4.
- **NS without glue A.** Resolvers can't find the nameserver; add the A record.
- **Forgot to allow SSH before enabling ufw.** Always `ufw allow OpenSSH` first.
