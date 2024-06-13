# Copyright (C) Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import urllib.parse
import boto3
from botocore.config import Config
import base64
import os
from io import BytesIO
from PIL import Image
from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth
import time


# This code uses products and descriptions from https://registry.opendata.aws/amazon-berkeley-objects/
embeddings_model_id="amazon.titan-embed-image-v1"
claude_sonnet_model_id="anthropic.claude-3-sonnet-20240229-v1:0"

contentType = "application/json"
accept = "application/json"
br_region=os.environ['AWS_REGION']

my_boto3_config = Config(
    connect_timeout = (60 * 3),
    read_timeout = (60 * 3),
    retries = {
        'max_attempts': 600,
        'mode': 'adaptive'
    }
)

bedrock = boto3.client("bedrock-runtime", region_name = br_region, config = my_boto3_config)

                            
# Function to create the OpenSearch client for AOSS
def auth_opensearch(host,  # serverless collection endpoint, without https://
                    region,
                    service='aoss'):
    # Get the credentials from the boto3 session
    print("Getting session credentials...")
    credentials = boto3.Session().get_credentials()
    auth = AWSV4SignerAuth(credentials, region, service)
    print("Completed getting session credentials.")

    # Create an OpenSearch client and use the request-signer
    print("Creating the OpenSearch client...")
    os_client = OpenSearch(
        hosts=[{'host': host, 'port': 443}],
        http_auth=auth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection,
        pool_maxsize=20,
        timeout=3000
    )
    print("Completed creating the OpenSearch client.")
    return os_client

collection_id=os.environ['OpenSearchCollectionId']
aoss_py_client = auth_opensearch(host = "{}.{}.aoss.amazonaws.com".format(collection_id, br_region),
                            service = 'aoss', region = br_region)                            
                            
#get the stringified request body for the InvokeModel API call
def get_image_understanding_request_body(prompt, input_image_base64, mask_prompt=None, negative_prompt=None):
    
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2000,
        "temperature": 0,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": input_image_base64,
                        },
                    },
                    {
                        "type": "text",
                        "text": prompt
                    }
                ],
            }
        ],
    }
    
    return json.dumps(body)


def generate_image_label(base64Image):
    #https://catalog.workshops.aws/building-with-amazon-bedrock/en-US/image-labs/bedrock-image-understanding
    
    body = get_image_understanding_request_body("Please provide a brief caption for this image in one sentence.", base64Image)
    response = bedrock.invoke_model(body=body, modelId=claude_sonnet_model_id, accept=accept, contentType=contentType)
    response_body = json.loads(response.get("body").read())
    output = response_body['content'][0]['text']
    return output


def create_product_embedding(base64Image, generatedImageLabel):
    bodyWithImageAndDescription = json.dumps(
        {
            "inputText": generatedImageLabel,
            "inputImage": base64Image
        }
    )
    
    response = bedrock.invoke_model(body=bodyWithImageAndDescription, modelId=embeddings_model_id, accept=accept, contentType=contentType)
    response_body = json.loads(response.get("body").read())
    return response_body.get("embedding")
    
def search_in_vector_db(embedding):
    if not embedding:
        # Return all records
        search_query = {
            "size": 25,
            "_source": ["prodId", "productName", "imageUrl"],
            "query":{
                "match_all": {}
                }
            }
    else:
        # Do knn search
        k=5
        search_query = {
            "size": k,
            "_source": ["prodId", "productName", "imageUrl"],
            "query":{
                "knn": {
                    "product_image_and_description_embedding": {
                        "vector": embedding,
                        "k": k,
                        },
                    }
                }
            }

    search_results = aoss_py_client.search(index="product-embeddings-index", body=search_query)
    matching_hits = search_results['hits']['hits']
    results = [(item['_source']['prodId'],item['_source']['productName'],item['_source']['imageUrl'],item['_score']) for item in matching_hits]
    return results

def do_visual_search(body_json):
    base64_file_content = body_json['content']

    # Generate image label from claude
    generatedLabel = generate_image_label(base64_file_content)
    print("Generated image label is " + generatedLabel)

    # Create multimodal embedding
    embedding = create_product_embedding(base64_file_content, generatedLabel)
    print("Created multimodal embedding")
    
    # search in Amazon OpenSearch Serverless index
    searchResults = search_in_vector_db(embedding)
    print("Search results are " + str(searchResults))
    
    return searchResults

# This lambda function supports two API Gateway endpoints - 
# 1. GET https://xxxxxx.execute-api.us-west-2.amazonaws.com/prod/products
# 2. POST https://xxxxxx.execute-api.us-west-2.amazonaws.com/prod/products/search
def lambda_handler(event, context):
    
    print("Starting product search. Event is  " + json.dumps(event))
    start = time.time()
    
    # API Gateway passes the input in the API Gateway lambda proxy integration format.
    # https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
    # The JSON input passed will be in the "body" field of "event".
    # For GET requests, the "body" field will be null.
    search_results = {}
    
    isBase64Encoded = event['isBase64Encoded']
    body = event['body']
       
    if isBase64Encoded:
       body_json = json.loads(base64.b64decode(body))
    else:
       body_json = json.loads(body)
           
    if "content" in body_json :
        # Image is in the body.content field in base64 encoded format. Do a visual search.
        search_results = do_visual_search(body_json)
    else:
        # Return all products
        search_results = search_in_vector_db([])
        
    # Convert response to the format expected by API Gateway
    response = {
            "isBase64Encoded": False,
            "statusCode": 200,
            "body": json.dumps(search_results)
        }
    end = time.time()
    print("Completed product search in %.2f seconds" % (end - start))
    
    return response
