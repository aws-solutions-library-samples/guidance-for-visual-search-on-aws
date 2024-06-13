# Copyright (C) Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import urllib.parse
import boto3
import os
from botocore.config import Config
from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth

contentType = "application/json"
accept = "application/json"
br_region=os.environ['AWS_REGION']

                           
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
    print("Creating the OpenSearch client at the host " + host)
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

                           
                            

def lambda_handler(event, context):
    collection_id=os.environ['OpenSearchCollectionId']
    aoss_py_client = auth_opensearch(host = "{}.{}.aoss.amazonaws.com".format(collection_id, br_region),
                            service = 'aoss', region = br_region)
    
    hnsw_index_body = {
        "settings":{
            "index.knn":True
        },
        "mappings":{
            "properties":{
                "product_image_and_description_embedding":{
                    "type":"knn_vector",
                    "dimension":1024,
                    "method":{
                    "name":"hnsw",
                    "engine":"nmslib",
                    "space_type":"cosinesimil"
                    }
                },
                "prodId":{
                    "type":"text"
                },
                "productName":{
                    "type":"text"
                },
                "imageUrl":{
                    "type":"text"
                }
            }
        }
    }

    index_name = 'product-embeddings-index'
    # Create the index if it does not exist
    if aoss_py_client.indices.exists(index = index_name):
        print("AOSS index product-embeddings-index already exists.")
    else:
        print("Creating AOSS index product-embeddings-index")
        response = aoss_py_client.indices.create(index = index_name, body = hnsw_index_body, ignore = 400)
    
    return "Done"