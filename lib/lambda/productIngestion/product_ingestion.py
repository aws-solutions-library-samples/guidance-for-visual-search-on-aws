# Copyright (C) Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import urllib.parse
import boto3
from botocore.config import Config
from botocore import UNSIGNED
import base64
import os
from io import BytesIO
from PIL import Image
from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth
import time

s3 = boto3.client('s3')
# berkeley's images are in a public bucket which needs to be accessed with unsigned requests
s3_unsigned = boto3.client('s3', config=Config(signature_version=UNSIGNED))

bucket = os.environ['VisualSearchS3Bucket']
berkeley_bucket="amazon-berkeley-objects" 
product_feed_file = "products.json"

# This code uses products and descriptions from https://registry.opendata.aws/amazon-berkeley-objects/
embeddings_model_id="amazon.titan-embed-image-v1"

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
                            
def get_products():
     # Get the object from the event and show its content type
    try:
        response = s3.get_object(Bucket=bucket, Key=product_feed_file)
        json_file_string = response['Body'].read().decode('utf-8')
    except Exception as e:
        print(e)
        print('Error getting object {} from bucket {}. Make sure they exist and your bucket is in the same region as this function.'.format(product_feed_file, bucket))
        raise e
    
    # Load the JSON string into a dictionary
    return json.loads(json_file_string)

def fetch_and_encode_image(image_name:str):
    # Download product image from source S3 bucket
    print("Going to fetch image " + berkeley_bucket + "/images/original/" + image_name)
    obj = s3_unsigned.get_object(Bucket=berkeley_bucket, Key=("images/original/" + image_name))
    
    image_obj=obj['Body'].read()

    image_name_nodir = image_name.split("/")[1]

    # Upload the image to our S3 bucket
    s3.put_object(
        Body=image_obj,
        Bucket=bucket,
        Key="images/" + image_name_nodir
    )
    
    print("Going to encode image " + image_name)
    try:
        image = Image.open(BytesIO(image_obj))
        image.thumbnail((2048,2048))

        # Convert image to base64
        buffered = BytesIO()
        image_format = image.format if image.format else 'JPEG' 
        image.save(buffered, format=image_format)
        print("Going to base64 encode image")
        return base64.b64encode(buffered.getvalue()).decode()
    except Exception as e:
        print(e)
        raise e
    
def create_product_embedding(product):
    encoded_image = fetch_and_encode_image(product["main_image_path"])
    bodyWithImageAndDescription = json.dumps(
        {
            "inputText": product["item_name"][0]["value"],
            "inputImage": encoded_image
        }
    )
    
    response = bedrock.invoke_model(body=bodyWithImageAndDescription, modelId=embeddings_model_id, accept=accept, contentType=contentType)
    response_body = json.loads(response.get("body").read())
    return response_body.get("embedding")
    
def store_in_vector_db(productId, productName, imageUrl, embedding):
    document = {
        'prodId': productId,
        'productName': productName,
        'imageUrl': imageUrl,
        'product_image_and_description_embedding': embedding,
    }
    
    response = aoss_py_client.index(
        index = 'product-embeddings-index',
        body = document
    )
    

def lambda_handler(event, context):
    product_json = get_products()
    
    print("Starting product feed ingestion")
    start = time.time()
    for product in product_json:
        print(f"Product ID: {product['item_id']}")
        embedd = create_product_embedding(product)
        store_in_vector_db(product['item_id'], 
                           product["item_name"][0]["value"], 
                           product['main_image_path'].split("/")[1], 
                           embedd)

    end = time.time()
    print("Completed product feed ingestion in %.2f seconds" % (end - start))
        
    return "Done"