#!/usr/bin/env bash
# Provision keyless Google credentials for the google-workspace Amp plugin.
#
#   google-setup.sh --project <gcp-project-id> --amp-workspace-id <uuid> [options]
#
# Creates, in one Google Cloud project, everything the plugin's workload identity credential needs:
#
#   1. the Drive, Docs, Sheets, IAM, IAM Credentials, and Security Token Service APIs enabled;
#   2. a service account (default amp-google-workspace) that owns nothing and holds no key;
#   3. a workload identity pool (default amp-orbs) with an OIDC provider (default amp) that trusts
#      https://ampcode.com/api/workload-identity and admits only tokens from your Amp workspace;
#   4. an IAM binding that lets every orb in that workspace impersonate the service account.
#
# It then prints the `amp secrets set` commands that turn this into workspace configuration. No
# secret is created or printed: orbs prove who they are with `amp orb id-token`, Google exchanges that
# proof for a one-hour token, and nothing long-lived exists to leak or rotate.
#
# Options
#   --project <id>              Google Cloud project that owns the pool and service account (required)
#   --amp-workspace-id <uuid>   Amp workspace whose orbs may act as the service account (required;
#                               `amp orb id-token --audience x` and decode the `workspace_id` claim, or
#                               ask Amp for the workspace id)
#   --amp-project-id <uuid>     Admit only orbs of this Amp project instead of the whole workspace
#   --service-account <id>      Service account id (default amp-google-workspace)
#   --pool <id>                 Workload identity pool id (default amp-orbs)
#   --provider <id>             Provider id for Amp (default amp)
#   --delegation                Also grant roles/iam.serviceAccountTokenCreator so GOOGLE_IMPERSONATE_USER
#                               works (requires domain-wide delegation in the Google Workspace admin console)
#   --github-repository <o/r>   Also trust GitHub Actions from one repository (provider `github`) so its
#                               workflows can run the contract tests without a key
#   --key <file>                Fallback for organizations that cannot federate: create a JSON key at
#                               <file> and print the command that stores it as a workspace secret
#   --dry-run                   Print every mutating gcloud command instead of running it
#
# Re-running is safe: every step checks before it creates, and the provider's mapping and condition
# are updated in place so adding --amp-project-id later converges.
#
# Requires gcloud (https://cloud.google.com/sdk) authenticated as someone with
# roles/iam.workloadIdentityPoolAdmin, roles/iam.serviceAccountAdmin, and roles/serviceusage.serviceUsageAdmin
# on the project. Run it from a workstation, not from an orb.
set -euo pipefail

AMP_ISSUER='https://ampcode.com/api/workload-identity'
GITHUB_ISSUER='https://token.actions.githubusercontent.com'
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ID_RE='^[a-z][a-z0-9-]{2,29}$'

project=''
workspace_id=''
amp_project_id=''
service_account='amp-google-workspace'
pool='amp-orbs'
provider='amp'
delegation=false
github_repository=''
key_file=''
dry_run=false

usage() { awk 'NR > 1 && /^set -euo/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; }
die() { echo "google-setup.sh: $*" >&2; exit 1; }
note() { printf '\n== %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) project=${2:?--project needs a value}; shift 2 ;;
    --amp-workspace-id) workspace_id=${2:?--amp-workspace-id needs a value}; shift 2 ;;
    --amp-project-id) amp_project_id=${2:?--amp-project-id needs a value}; shift 2 ;;
    --service-account) service_account=${2:?--service-account needs a value}; shift 2 ;;
    --pool) pool=${2:?--pool needs a value}; shift 2 ;;
    --provider) provider=${2:?--provider needs a value}; shift 2 ;;
    --delegation) delegation=true; shift ;;
    --github-repository) github_repository=${2:?--github-repository needs a value}; shift 2 ;;
    --key) key_file=${2:?--key needs a file path}; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[[ -n "$project" ]] || die "--project is required"
[[ -n "$workspace_id" ]] || die "--amp-workspace-id is required"
[[ "$workspace_id" =~ $UUID_RE ]] || die "--amp-workspace-id must be a UUID, got '$workspace_id'"
[[ -z "$amp_project_id" || "$amp_project_id" =~ $UUID_RE ]] || die "--amp-project-id must be a UUID, got '$amp_project_id'"
for pair in "service-account:$service_account" "pool:$pool" "provider:$provider"; do
  [[ "${pair#*:}" =~ $ID_RE ]] || die "--${pair%%:*} must be 3-30 lowercase letters, digits, or hyphens, starting with a letter"
done
[[ -z "$github_repository" || "$github_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--github-repository must be owner/repo"
command -v gcloud >/dev/null || die "gcloud is not installed; see https://cloud.google.com/sdk/docs/install"

# Mutating gcloud calls go through here so --dry-run can show them.
run() {
  if $dry_run; then
    printf '+'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

gcloud_read() { gcloud "$@" --project="$project" --format='value(name)' 2>/dev/null; }
pool_state() {
  gcloud iam workload-identity-pools describe "$pool" --project="$project" --location=global --format='value(state)' 2>/dev/null || true
}
provider_state() {
  gcloud iam workload-identity-pools providers describe "$1" --project="$project" --location=global \
    --workload-identity-pool="$pool" --format='value(state)' 2>/dev/null || true
}

note "Project $project"
project_number=$(gcloud projects describe "$project" --format='value(projectNumber)') ||
  die "cannot read project $project; check 'gcloud auth list' and the project id"
echo "project number: $project_number"
sa_email="${service_account}@${project}.iam.gserviceaccount.com"

note "APIs"
run gcloud services enable --project="$project" \
  drive.googleapis.com docs.googleapis.com sheets.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

note "Service account $sa_email"
if [[ -n "$(gcloud_read iam service-accounts describe "$sa_email")" ]]; then
  echo "exists"
else
  run gcloud iam service-accounts create "$service_account" --project="$project" \
    --display-name='Amp google-workspace plugin' \
    --description='Identity the google-workspace Amp plugin acts as. Share Drive files or folders with this address.'
fi

# Ensures a pool or provider exists and is ACTIVE, undeleting one that is inside its 30-day grace period.
ensure_active() {
  local kind=$1 state=$2; shift 2
  case "$state" in
    ACTIVE) echo "exists" ;;
    DELETED) echo "undeleting"; run gcloud iam workload-identity-pools "$@" ;;
    *) return 1 ;;
  esac
}

note "Workload identity pool $pool"
ensure_active pool "$(pool_state)" undelete "$pool" --project="$project" --location=global ||
  run gcloud iam workload-identity-pools create "$pool" --project="$project" --location=global \
    --display-name='Amp orbs' --description='Orbs proving their identity with amp orb id-token'

# Amp claims: workspace_id, project_id (absent for orbs without a project), user_id, thread_id, token_use.
# thread_id is the subject because it is unique and shorter than Google's 127-byte limit on google.subject.
# project_id is mapped only when the condition guarantees it is present: a mapping that names an absent
# claim rejects the token.
mapping='google.subject=assertion.thread_id,attribute.workspace_id=assertion.workspace_id,attribute.user_id=assertion.user_id'
condition="assertion.workspace_id == '${workspace_id}' && assertion.token_use == 'exchanged'"
principal="principalSet://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${pool}/attribute.workspace_id/${workspace_id}"
if [[ -n "$amp_project_id" ]]; then
  mapping="${mapping},attribute.project_id=assertion.project_id"
  condition="${condition} && assertion.project_id == '${amp_project_id}'"
  principal="principalSet://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${pool}/attribute.project_id/${amp_project_id}"
fi

# No --allowed-audiences: Google then accepts its default audience, https://iam.googleapis.com/<provider name>,
# which is what the plugin asks `amp orb id-token` for. Nothing to keep in sync.
ensure_provider() {
  local id=$1 issuer=$2 display=$3 map=$4 cond=$5
  note "Provider $id ($issuer)"
  if ensure_active provider "$(provider_state "$id")" providers undelete "$id" --project="$project" --location=global --workload-identity-pool="$pool"; then
    run gcloud iam workload-identity-pools providers update-oidc "$id" --project="$project" --location=global \
      --workload-identity-pool="$pool" --issuer-uri="$issuer" --attribute-mapping="$map" --attribute-condition="$cond"
    local audiences
    audiences=$(gcloud iam workload-identity-pools providers describe "$id" --project="$project" --location=global \
      --workload-identity-pool="$pool" --format='value(oidc.allowedAudiences)' 2>/dev/null || true)
    if [[ -n "$audiences" ]]; then
      echo "warning: provider $id restricts audiences to '$audiences'; the plugin sends Google's default" >&2
      echo "         https://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${pool}/providers/${id}" >&2
      echo "         Clear the list in the console (Workload Identity Pools > $pool > $id > Allowed audiences) or add that value." >&2
    fi
  else
    run gcloud iam workload-identity-pools providers create-oidc "$id" --project="$project" --location=global \
      --workload-identity-pool="$pool" --display-name="$display" \
      --issuer-uri="$issuer" --attribute-mapping="$map" --attribute-condition="$cond"
  fi
}

ensure_provider "$provider" "$AMP_ISSUER" 'Amp' "$mapping" "$condition"

note "Impersonation grants on $sa_email"
run gcloud iam service-accounts add-iam-policy-binding "$sa_email" --project="$project" \
  --role=roles/iam.workloadIdentityUser --member="$principal" --condition=None --format=none
echo "roles/iam.workloadIdentityUser -> $principal"
if $delegation; then
  run gcloud iam service-accounts add-iam-policy-binding "$sa_email" --project="$project" \
    --role=roles/iam.serviceAccountTokenCreator --member="$principal" --condition=None --format=none
  echo "roles/iam.serviceAccountTokenCreator -> $principal"
fi

github_provider_name=''
if [[ -n "$github_repository" ]]; then
  # GitHub's subject (repo:owner/repo:ref:refs/heads/main) fits in 127 bytes for ordinary names.
  github_map='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner'
  github_cond="assertion.repository == '${github_repository}'"
  github_principal="principalSet://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${pool}/attribute.repository/${github_repository}"
  ensure_provider github "$GITHUB_ISSUER" 'GitHub Actions' "$github_map" "$github_cond"
  run gcloud iam service-accounts add-iam-policy-binding "$sa_email" --project="$project" \
    --role=roles/iam.workloadIdentityUser --member="$github_principal" --condition=None --format=none
  echo "roles/iam.workloadIdentityUser -> $github_principal"
  github_provider_name="projects/${project_number}/locations/global/workloadIdentityPools/${pool}/providers/github"
fi

if [[ -n "$key_file" ]]; then
  note "Service account key (fallback)"
  [[ ! -e "$key_file" ]] || die "$key_file already exists; refusing to overwrite a key"
  run gcloud iam service-accounts keys create "$key_file" --project="$project" --iam-account="$sa_email"
  echo "key written to $key_file; this is a long-lived secret. Store it, then delete the file:"
  echo "  amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_KEY --secret --data-file '$key_file' && rm '$key_file'"
  echo "Rotate it by deleting the key (gcloud iam service-accounts keys list --iam-account='$sa_email') and re-running with --key."
fi

provider_name="projects/${project_number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}"
if ! $dry_run; then
  provider_name=$(gcloud iam workload-identity-pools providers describe "$provider" --project="$project" --location=global \
    --workload-identity-pool="$pool" --format='value(name)')
fi

cat <<EOF

== Done. Wire it into Amp

Workspace-wide (needs an Amp workspace admin; every orb in the workspace gets these as plain environment variables):

  printf '%s' '${provider_name}' | amp secrets set --workspace GOOGLE_WORKLOAD_IDENTITY_PROVIDER --env --data-file -
  printf '%s' '${sa_email}' | amp secrets set --workspace GOOGLE_SERVICE_ACCOUNT_EMAIL --env --data-file -

Optional, recommended until you need the write tools:

  printf '%s' '1' | amp secrets set --workspace GOOGLE_WORKSPACE_READ_ONLY --env --data-file -
EOF
if $delegation; then
  cat <<EOF

Domain-wide delegation: in the Google Admin console (Security > Access and data control > API controls >
Domain-wide delegation) authorize this service account's OAuth client id for the exact Drive scope the plugin
requests (https://www.googleapis.com/auth/drive, or .../drive.readonly with GOOGLE_WORKSPACE_READ_ONLY), then:

  printf '%s' 'amp-user' | amp secrets set --workspace GOOGLE_IMPERSONATE_USER --env --data-file -

Client id: $(gcloud iam service-accounts describe "$sa_email" --project="$project" --format='value(oauth2ClientId)' 2>/dev/null || echo '<see console>')
EOF
fi
if [[ -n "$github_provider_name" ]]; then
  cat <<EOF

GitHub Actions (${github_repository}) contract tests, as repository variables, not secrets:

  gh variable set GOOGLE_WORKLOAD_IDENTITY_PROVIDER --repo '${github_repository}' --body '${github_provider_name}'
  gh variable set GOOGLE_SERVICE_ACCOUNT_EMAIL --repo '${github_repository}' --body '${sa_email}'
  gh variable set GOOGLE_WORKSPACE_CONTRACT_FOLDER --repo '${github_repository}' --body '<drive folder id shared with ${sa_email} as Editor>'
EOF
fi
cat <<EOF

Share Drive content with ${sa_email}: one folder (or a Shared Drive) as Viewer/Commenter for reading, Editor for the
write tools. Then in any orb of workspace ${workspace_id} run \`amp orb restart-processes\` and ask Amp to run
gdrive_whoami, or use the command "google-workspace: check Google credentials".
EOF
