cd ./recieve-email && \
npm ci && \
cd .. && \
zip -r recieve-email.zip ./recieve-email && 
aws lambda update-function-code --function-name EmailProcessingLambda --zip-file fileb://recieve-email.zip && \
rm recieve-email.zip