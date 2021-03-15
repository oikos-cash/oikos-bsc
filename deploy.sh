#!/bin/bash
set +x

rm -rf build/
node publish build
cat > publish/deployed/bsc/deployment.json <<EOF
{
	"targets": {},
	"sources": {}
}
EOF

sed -i 's/false/true/g' publish/deployed/bsc/config.json
node publish deploy -n bsc -d publish/deployed/bsc -g 20 --yes