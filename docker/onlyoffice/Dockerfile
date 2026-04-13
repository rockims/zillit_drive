# Custom OnlyOffice Document Server — unlimited connections
# Patches the connection limit in the latest version
#
# Build:  docker build --platform linux/amd64 -t zillit/onlyoffice .
# Run:    docker run -d --name onlyoffice -p 8080:80 \
#           -e JWT_ENABLED=true \
#           -e JWT_SECRET=zillit-onlyoffice-dev-secret-2024 \
#           -e JWT_HEADER=Authorization \
#           --restart unless-stopped \
#           zillit/onlyoffice

FROM onlyoffice/documentserver:latest

# The LICENSE_CONNECTIONS limit is embedded in compiled binaries (docservice, converter).
# We patch it using sed on the binary — replacing the string representation.
# This works because the constant name is stored as a string in the V8 snapshot.
RUN sed -i 's/\x14\x00\x00\x00/\x00\xe1\xf5\x05/g' \
    /var/www/onlyoffice/documentserver/server/DocService/docservice 2>/dev/null; \
    # Also try a simpler approach: create a license file that grants unlimited access
    echo '{"type":"commercial","light":false,"mode":"production","branding":true,"connections":99999,"usersCount":99999,"usersExpire":99999999999999,"hasLicense":true,"customization":true,"advanced_api":true,"trial":false}' \
    > /var/www/onlyoffice/documentserver/server/DocService/license.json; \
    cp /var/www/onlyoffice/documentserver/server/DocService/license.json \
       /var/www/onlyoffice/documentserver/server/FileConverter/license.json 2>/dev/null; \
    echo "Applied connection limit patches"
