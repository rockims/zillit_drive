#!/bin/bash

# Complete File Sharing Workflow Test
echo "🔄 Complete File Sharing Workflow Test"
echo "======================================"

# Configuration
MODULE_DATA="9bf45a428070559f3376f051dd8877f1cdc26fed18a17e5d9f05337339f17aaa2dcb4c3474635573f852906b03eeab055b53675d1c163c04a58173d85a4fba3bc24b2494c14e2f943e44738ecfe9dab8818d7fe7a9ac6ecbd9bffa85e295cd4f8f288371124b3e34ff5989b589685eb975bc1eb34020fb1924b72e64c1fd4d73f9e439c1ab7104103a2f2094f8ff6e40349954d10bee1fde2f9df25fd019413b"
FILE_ID="68f0cb8bdcbea8318fcaafb6"

echo ""
echo "📝 Step 1: Create Share Link"
SHARE_RESPONSE=$(curl -s -X POST \
-H "Content-Type: application/json" \
-H "moduledata: $MODULE_DATA" \
-d '{"permissions":"read","expires_at":"2026-12-31T23:59:59Z"}' \
"http://localhost:8105/api/v2/drive/files/$FILE_ID/share")

echo "$SHARE_RESPONSE"

# Extract the share token from the response
SHARE_TOKEN=$(echo "$SHARE_RESPONSE" | grep -o '"share_token":"[^"]*"' | cut -d'"' -f4)

echo ""
echo "🔗 Extracted Share Token: $SHARE_TOKEN"

if [ ! -z "$SHARE_TOKEN" ]; then
    echo ""
    echo "📝 Step 2: Test Public Access with Generated Token"
    PUBLIC_RESPONSE=$(curl -s -H "moduledata: $MODULE_DATA" \
    "http://localhost:8105/api/v2/drive/public/$SHARE_TOKEN")
    echo "$PUBLIC_RESPONSE"
    
    echo ""
    echo "📝 Step 3: List File Shares"
    SHARES_RESPONSE=$(curl -s -H "moduledata: $MODULE_DATA" \
    "http://localhost:8105/api/v2/drive/files/$FILE_ID/shares")
    echo "$SHARES_RESPONSE"
    
    echo ""
    echo "📝 Step 4: Revoke Share"
    REVOKE_RESPONSE=$(curl -s -X DELETE -H "moduledata: $MODULE_DATA" \
    "http://localhost:8105/api/v2/drive/files/$FILE_ID/share")
    echo "$REVOKE_RESPONSE"
    
    echo ""
    echo "📝 Step 5: Test Access After Revocation"
    POST_REVOKE_RESPONSE=$(curl -s -H "moduledata: $MODULE_DATA" \
    "http://localhost:8105/api/v2/drive/public/$SHARE_TOKEN")
    echo "$POST_REVOKE_RESPONSE"
else
    echo "❌ Failed to extract share token from response"
fi

echo ""
echo "🎯 Test Complete!"
echo ""
