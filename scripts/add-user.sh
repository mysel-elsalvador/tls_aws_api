#!/usr/bin/env bash
# Creates a Cognito user (Cognito emails a temporary password) and links it
# to an organization through the admin Lambda.
#   scripts/add-user.sh dev ana@example.com puma [viewer|admin] [all|2,3]
# STATIONS: "all" = every station of the organization; a comma-separated
# list of station ids = grant those; empty = a new user sees none (an
# existing user keeps its scope and grants). Admins always see every station.
# Re-running for an existing user only (re)links it and adds grants.
set -euo pipefail
env=$1 email=$2 org=$3 role=${4:-viewer} stations=${5:-}
[[ -n $email && -n $org ]] || { echo "usage: $0 ENV EMAIL ORG [ROLE] [all|ID,ID...]" >&2; exit 2; }
[[ -z $stations || $stations == all || $stations =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]] ||
  { echo "STATIONS must be all or a comma-separated list of station ids" >&2; exit 2; }
stack=hub-web-$env

pool=$(aws cloudformation describe-stacks --stack-name "$stack" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

if ! sub=$(aws cognito-idp admin-get-user --user-pool-id "$pool" --username "$email" \
  --query "UserAttributes[?Name=='sub'].Value" --output text 2>/dev/null); then
  sub=$(aws cognito-idp admin-create-user --user-pool-id "$pool" --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
    --desired-delivery-mediums EMAIL \
    --query "User.Attributes[?Name=='sub'].Value" --output text)
  echo "created $email (temporary password sent by email)"
fi

out=$(mktemp)
trap 'rm -f "$out"' EXIT
# admin ACTION [KEY VALUE]...: invokes the admin Lambda, prints the answer, fails if not ok.
admin() {
  local payload
  payload=$(python3 -c 'import json,sys
a=sys.argv[1:]; d={"action":a[0]}
for k,v in zip(a[1::2],a[2::2]): d[k]={"true":True,"false":False}.get(v,v)
print(json.dumps(d))' "$@")
  aws lambda invoke --function-name "$stack-admin:live" --cli-binary-format raw-in-base64-out \
    --payload "$payload" "$out" >/dev/null
  python3 -m json.tool "$out"
  python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("ok") else 1)' "$out"
}

if [[ $stations == all ]]; then
  admin add_user org "$org" sub "$sub" email "$email" role "$role" all_stations true
else
  admin add_user org "$org" sub "$sub" email "$email" role "$role"
  for id in ${stations//,/ }; do
    admin grant_station org "$org" email "$email" station "$id"
  done
fi
