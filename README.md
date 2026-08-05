# PAI Memory and Deploy Worker - Cloudflare Setup Guide

## Overview

This guide documents the deployment of PAI Memory and Deploy workers using Cloudflare's platform, with Cloudflare-native patterns for L5 Trust-Gate and L6 Gossip.

## Purpose

This setup configures:
1. Cloudflare DNS for `axiomid.app` subdomains
2. PAI Memory L2 and L3 Durable Objects
3. PAI Deploy worker with L5/L6 abstraction patterns
4. End-to-end security validation

## Prerequisites

- Cloudflare account with API access
- Cloudflare API token with required permissions
- Docker environment
- Node.js 20+ and Go 1.25+

## Setup Steps

### 1. CloudFlare API Token Setup

Create a Cloudflare API token with the following permissions:
- `Zone:Read` - to list zones and DNS records
- `Zone:DNS:Edit` - to create/delete DNS records
- `Zone:Edit` - to modify SSL settings
- `User:Read` - to verify token
- (Optional) `Access Apps:Read` - for Zero Trust policies

**To create the token:**
1. Log in to Cloudflare dashboard
2. Go to `My Profile` → `API Tokens` → `Create API Token`
3. Select "Custom token"
4. Add permissions:
   - `Zone:Read`
   - `Zone:DNS:Edit`
   - `Zone:Edit`
   - `User:Read`
5. Save the token and store it securely

### 2. Environment Configuration

Create a `.env` file with your Cloudflare API token:
```bash
cat > .env <<EOF
CF_API_TOKEN=your_token_here
EOF
chmod 600 .env
```

### 3. Worker Deployment

Run the deployment script:
```bash
cd cloudflare-setup
./setup.sh
```

This script will:
- Verify API token permissions
- Create/update DNS records for all subdomains
- Deploy PAI Memory L2 and L3 workers
- Deploy PAI Deploy worker

### 4. Verification

Check that all workers are deployed correctly:
```bash
# Check Cloudflare DNS records
curl "https://api.cloudflare.com/client/v4/zones" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" | jq '.result[] | select(.name == "axiomid.app")'

# List all DNS records for api.axiomid.app
curl "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" | jq '.result[] | select(.name | endswith(".axiomid.app"))'
```

## Subdomain Configuration

### Active Subdomains

| Subdomain | Target | Purpose |
|-----------|--------|---------|
| `api.axiomid.app` | CNAME → `pai-api-gateway.vercel-dns.com` | PAI API Gateway |
| `docs.axiomid.app` | CNAME → `pai-docs.vercel-dns.com` | PAI Documentation |
| `build.axioid.app` | CNAME → `pai-build.vercel-dns.com` | PAI Build System |
| `skills.axiomid.app` | CNAME → `pai-skills.vercel-dns.com` | PAI Skills Marketplace |
| `memory.axiomid.app` | CNAME → `pai-memory.vercel-dns.com` | PAI Memory Service |
| `deploy.axiomid.app` | PAI Deploy Worker | Deployment Platform |

### DNS Record Creation

Each subdomain is configured as a CNAME record pointing to its respective Vercel deployment:
```json
{
  "type": "CNAME",
  "name": "subdomain",
  "content": "target.vercel-dns.com",
  "ttl": 300,
  "proxied": false
}
```

## Security Model

### L5 Trust-Gate

The deployment implements a lightweight L5 Trust-Gate system:

1. **Token-based Authentication**: API tokens with tenant and scope restrictions
2. **Fine-grained Permissions**: Read, write, deploy, and admin scopes
3. **Token Lifecycle Management**: Expiration and revocation mechanisms

**Token Generation API**:
```
POST /deploy/token
{
  "tenant": "string",
  "scopes": ["read", "write", "deploy", "admin"]
}
```

### L6 Gossip

The deploy worker uses L6 Gossip for artifact distribution:

1. **Artifact Registration**: Store artifacts in R2 with metadata in KV
2. **Gossip Propagation**: Distribute artifacts across worker instances
3. **Tenant Isolation**: Each tenant manages their own artifacts

## Worker Architecture

### PAI Memory Workers

#### L2 Episodic Chain (pai-memory-l2)
- **Durable Object**: L2EpisodicDO
- **Database**: D1 database (ID: `5c5da39d-91d2-4ff7-b0b6-e0b4278361bc`)
- **Purpose**: Session/episodic memory storage
- **Capacity**: 1MiB soft / 10MiB hard

#### L3 Facts/Semantic Graph (pai-memory-l3)
- **Durable Object**: L3FactGraphDO
- **Database**: D1 database (ID: `483018c5-3b89-4315-9b1b-112112f7577f`)
- **Purpose**: Facts and semantic memory storage
- **Capacity**: 100MiB soft / 500MiB hard

### PAI Deploy Worker

#### L5 Trust-Gate
- **Token Validation**: Validate deployment tokens against KV store
- **Scope Checking**: Verify token scopes against requested operations
- **Token Generation**: Generate scoped tokens for tenants

#### L6 Gossip
- **Artifact Registry**: Register and manage deployment artifacts
- **Distribution**: Propagate artifacts across worker instances
- **Tenant Indexing**: Maintain tenant-specific artifact indexes

## API Reference

### Deploy Worker Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/deploy/register` | POST | Register a new deployment artifact |
| `/deploy/list` | GET | List artifacts for a tenant |
| `/deploy/artifact/:id` | GET | Get specific artifact |
| `/deploy/token` | POST | Generate deployment token |
| `/health` | GET | Health check |

### Example Usage

```bash
# Generate deployment token
curl -X POST /deploy/token \
  -H "Content-Type: application/json" \
  -d '{"tenant": "my-tenant", "scopes": ["read", "deploy"]}'

# Register artifact
curl -X POST /deploy/register \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "artifact-123",
    "name": "My Application",
    "description": "A sample application",
    "version": "1.0.0",
    "createdAt": 1609459200000,
    "size": 1024,
    "mimeType": "application/json",
    "tags": ["web", "api"],
    "tenant": "my-tenant",
    "access": "public"
  }'
```

## Monitoring and Observability

### Health Checks

The deploy worker provides health monitoring:
- **Health Endpoint**: `/health` returns `OK` if healthy
- **Access Logs**: All requests logged to Cloudflare Analytics
- **KV Metrics**: Cache hit/miss ratios for token validation

### Error Handling

All error responses follow a consistent format:
```json
{
  "success": false,
  "error": "Error message"
}
```

### Common Errors

| Status Code | Error Message | Description |
|-------------|---------------|-------------|
| `400` | "Missing required fields" | Request body missing required fields |
| `401` | "Invalid token" | Token is invalid or expired |
| `403` | "Insufficient permissions" | Token does not have required scope |
| `404` | "Artifact not found" | Artifact does not exist |
| `500` | "Internal server error" | Unexpected server error |

## Security Considerations

### Token Management

1. **Token Storage**: Store API tokens securely in environment files
2. **Token Rotation**: Regularly rotate API tokens
3. **Scope Limitation**: Use minimal required scopes for tokens
4. **Token Validation**: Validate tokens on each request

### Access Control

1. **Tenant Isolation**: Tokens are tenant-specific
2. **Scope-based Permissions**: Tokens have specific scopes
3. **Expiration**: Tokens have expiration times
4. **Revocation**: Tokens can be revoked by deleting from KV store

## Future Enhancements

### Planned Upgrades

1. **Artifact Deployment**: Actual deployment to production servers
2. **Artifact Hosting**: Static artifact hosting with CDN
3. **Multi-tenant Support**: Enhanced tenant isolation
4. **Advanced Permissions**: Role-based access control

### Gossip Network Expansion

The L6 Gossip system is planned to expand:

1. **Peer-to-peer Replication**: Multi-worker gossip protocol
2. **Conflict Resolution**: Automatic conflict detection and resolution
3. **Data Consistency**: Strong consistency guarantees

## Troubleshooting

### Common Issues

#### DNS Propagation Delays

If DNS changes don't propagate immediately:
1. Wait up to 24 hours for TTL to expire
2. Check `dig api.axiomid.app +short` to verify
3. Use `https://whatsmydns.net/` to check global propagation

#### API Token Issues

If API token verification fails:
1. Verify token has correct permissions
2. Check token hasn't expired
3. Ensure token isn't revoked in Cloudflare dashboard
4. Regenerate token if necessary

#### Worker Deployment Issues

If worker deployment fails:
1. Check Cloudflare dashboard for deployment status
2. Verify D1 database connectivity
3. Check logs for specific error details
4. Retry deployment with appropriate fixes

## License

MIT - Free for all agents, all humans, all purposes.

## Contact

For issues or questions:
- Check the PAI ecosystem documentation
- Review the Cloudflare setup logs
- Contact the PAI team for support

---

*Generated by PAI Deploy Worker with Cloudflare-native patterns*
*Version: 0.1.0*
*Last Updated: 2026-08-05*
