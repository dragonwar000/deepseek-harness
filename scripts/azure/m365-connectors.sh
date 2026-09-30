#!/usr/bin/env bash
# Provision the CTD-Core Microsoft 365 connector app registrations in Entra ID.
#
# One public-client app per data kind (mail, chat, files). Each app:
#   - requests only read-only delegated Microsoft Graph scopes;
#   - has "Assignment required" enabled, so Entra ID refuses tokens to anyone not assigned;
#   - is assigned to one security group SG-CTDCore-M365-<Kind>;
#   - carries tenant-wide admin consent (an AllPrincipals oauth2PermissionGrant) for its scopes.
#
# IT grants access by adding a user to the group and revokes it by removing the user and then running
# "Revoke sessions" on that user. Emergency stop: disable sign-in on the enterprise app
# (`az ad sp update --id <appId> --set accountEnabled=false`).
#
# The script is idempotent: rerunning it finds existing objects by display name and converges them.
# Usage: scripts/azure/m365-connectors.sh [member-upn ...]
#   Requires `az login` as a user able to create applications, groups, and grant admin consent.
#   Each member UPN is added to every connector group.
set -euo pipefail

GRAPH_APP_ID=00000003-0000-0000-c000-000000000000
GRAPH=https://graph.microsoft.com/v1.0
BASE_SCOPES='openid profile offline_access User.Read'

# kind|display suffix|extra scopes
CONNECTORS=(
  'mail|Mail|Mail.Read'
  'chat|Teams Chat|Chat.Read'
  'files|Files|Files.Read.All Sites.Read.All'
)

log() { printf '[m365-connectors] %s\n' "$*" >&2; }

graph_sp_id=$(az ad sp show --id "$GRAPH_APP_ID" --query id -o tsv)
tenant_id=$(az account show --query tenantId -o tsv)

# Resolve delegated scope names to Graph permission ids.
scope_id() {
  az ad sp show --id "$GRAPH_APP_ID" --query "oauth2PermissionScopes[?value=='$1'].id | [0]" -o tsv
}

ensure_app() { # $1 display name, $2 scope list -> prints appId
  local name=$1 scopes=$2 app_id access scope
  app_id=$(az ad app list --filter "displayName eq '$name'" --query '[0].appId' -o tsv)
  if [[ -z $app_id ]]; then
    log "creating app registration '$name'"
    app_id=$(az ad app create --display-name "$name" --sign-in-audience AzureADMyOrg \
      --public-client-redirect-uris http://localhost --is-fallback-public-client true --query appId -o tsv)
  fi
  access='[{"resourceAppId":"'$GRAPH_APP_ID'","resourceAccess":['
  local first=1
  for scope in $scopes; do
    [[ $first -eq 1 ]] || access+=','
    access+='{"id":"'$(scope_id "$scope")'","type":"Scope"}'
    first=0
  done
  access+=']}]'
  local object_id
  object_id=$(az ad app show --id "$app_id" --query id -o tsv)
  az rest --method PATCH --url "$GRAPH/applications/$object_id" --headers 'Content-Type=application/json' \
    --body '{"isFallbackPublicClient":true,"publicClient":{"redirectUris":["http://localhost"]},"requiredResourceAccess":'"$access"'}' >/dev/null
  printf '%s' "$app_id"
}

ensure_sp() { # $1 appId -> prints service principal object id
  local sp_id
  sp_id=$(az ad sp list --filter "appId eq '$1'" --query '[0].id' -o tsv)
  if [[ -z $sp_id ]]; then
    log "creating enterprise app for $1"
    sp_id=$(az ad sp create --id "$1" --query id -o tsv)
  fi
  az rest --method PATCH --url "$GRAPH/servicePrincipals/$sp_id" --headers 'Content-Type=application/json' \
    --body '{"appRoleAssignmentRequired":true}' >/dev/null
  printf '%s' "$sp_id"
}

ensure_group() { # $1 display name, $2 mail nickname -> prints group id
  local group_id
  group_id=$(az ad group list --filter "displayName eq '$1'" --query '[0].id' -o tsv)
  if [[ -z $group_id ]]; then
    log "creating security group '$1'"
    group_id=$(az ad group create --display-name "$1" --mail-nickname "$2" \
      --description 'Members may use this CTD-Core Microsoft 365 connector' --query id -o tsv)
  fi
  printf '%s' "$group_id"
}

ensure_assignment() { # $1 sp id, $2 group id
  local existing
  existing=$(az rest --method GET --url "$GRAPH/servicePrincipals/$1/appRoleAssignedTo" \
    --query "value[?principalId=='$2'].id | [0]" -o tsv)
  if [[ -z $existing ]]; then
    log "assigning group $2 to enterprise app $1"
    az rest --method POST --url "$GRAPH/servicePrincipals/$1/appRoleAssignedTo" --headers 'Content-Type=application/json' \
      --body '{"principalId":"'"$2"'","resourceId":"'"$1"'","appRoleId":"00000000-0000-0000-0000-000000000000"}' >/dev/null
  fi
}

ensure_consent() { # $1 client sp id, $2 scope list
  local grant_id
  grant_id=$(az rest --method GET \
    --url "$GRAPH/oauth2PermissionGrants?\$filter=clientId%20eq%20'$1'%20and%20resourceId%20eq%20'$graph_sp_id'%20and%20consentType%20eq%20'AllPrincipals'" \
    --query 'value[0].id' -o tsv)
  if [[ -z $grant_id ]]; then
    log "granting admin consent: $2"
    az rest --method POST --url "$GRAPH/oauth2PermissionGrants" --headers 'Content-Type=application/json' \
      --body '{"clientId":"'"$1"'","consentType":"AllPrincipals","resourceId":"'"$graph_sp_id"'","scope":"'"$2"'"}' >/dev/null
  else
    az rest --method PATCH --url "$GRAPH/oauth2PermissionGrants/$grant_id" --headers 'Content-Type=application/json' \
      --body '{"scope":"'"$2"'"}' >/dev/null
  fi
}

ensure_member() { # $1 group id, $2 user object id
  if [[ $(az ad group member check --group "$1" --member-id "$2" --query value -o tsv) != true ]]; then
    log "adding member $2 to group $1"
    az ad group member add --group "$1" --member-id "$2" >&2
  fi
}

member_ids=()
for upn in "$@"; do
  member_ids+=("$(az ad user show --id "$upn" --query id -o tsv)")
done

printf '{"tenantId":"%s","connectors":[' "$tenant_id"
sep=''
for row in "${CONNECTORS[@]}"; do
  IFS='|' read -r kind label extra <<<"$row"
  scopes="$BASE_SCOPES $extra"
  app_id=$(ensure_app "CTD-Core M365 Connector - $label" "$scopes")
  sp_id=$(ensure_sp "$app_id")
  group_name="SG-CTDCore-M365-${label// /}"
  group_id=$(ensure_group "$group_name" "sg-ctdcore-m365-$kind")
  ensure_assignment "$sp_id" "$group_id"
  ensure_consent "$sp_id" "$scopes"
  for member in "${member_ids[@]+"${member_ids[@]}"}"; do ensure_member "$group_id" "$member"; done
  printf '%s{"id":"%s","clientId":"%s","servicePrincipalId":"%s","group":"%s","groupId":"%s","scopes":"%s"}' \
    "$sep" "$kind" "$app_id" "$sp_id" "$group_name" "$group_id" "$extra"
  sep=','
done
printf ']}\n'
