# Guidance for Simple Visual Search on AWS

## Table of Contents

1. [Overview](#overview)
    - [Solution Overview](#solution-overview)
    - [Architecture Diagram](#architecture-diagram)
    - [Cost](#cost)
2. [Prerequisites](#prerequisites)
3. [Deployment Steps](#deployment-steps)
4. [Deployment Validation](#deployment-validation)
5. [Running the Guidance](#running-the-guidance)
6. [Next Steps](#next-steps)
7. [Cleanup](#cleanup)

## Overview

With mobile commerce leading retail growth, seamless in-app visual search unlocks frictionless purchase experiences. Visual search has evolved from a novelty to a business necessity. While technically complex to build at scale, visual search drives measurable metrics around engagement, conversion, and revenue when implemented successfully. As consumer expectations and behaviors shift towards more visual and intuitive shopping, brands need robust visual search to deliver next-generation shopping experiences. With visual search powering shopping across channels, brands can provide consumers with flexibility and convenience while capturing valuable data on emerging visual trends and consumer preferences. 


Visual search allows consumers to take or upload an image to search for visually similar images and products. This enables more intuitive and seamless product discoveries, allowing consumers to find products they see around them or even user-generated image content that resembles their particular style and tastes.

Developing accurate and scalable visual search is a complex technical challenge, which demands considerable investments in technology infrastructure and data management. However, recent advancements in generative AI and multimodal models are enabling exciting new possibilities in visual search.

This repo contains code that creates a visual search solution using services like Amazon Bedrock, Amazon Opensearch Serverless, Amazon Lambda etc.

### Solution Overview
The solution is an implementation of semantic search, based on product images. To enable search by product images, we first need to create a vector store index of multimodal embeddings from the image and description of all products in the catalog. When you search with an image, the image is run through Claude Sonnet V3 to generate a caption for the image, and then both the input image and generated caption are used to create a multimodal embedding. This multimodal embedding is used to query the vector store index, which then returns the requested number of semantic search results based on similarity scores.

### Architecture Diagram

![architecture](/assets/Guidance_SimpleVisualSearchOnAWS.jpg)

1. A time-based Amazon EventBridge scheduler invokes an AWS Lambda Function to populate search index with multimodal embeddings and product meta-data.

2. The AWS Lambda Function first retrieves product feed stored as a JSON file in Amazon Simple Storage Service (Amazon S3).

3. The Lambda Function then invokes Amazon Bedrock’s Titan Multimodal Embedding model to create vector embeddings for each product in the catalog, based on the primary image and description of the products.

4. The Lambda Function finally persists these vector embeddings as a k-NN vectors, along with product meta-data in Amazon OpenSearch vector index. This index is used as the source for semantic image search

5. The user initiates a visual search request through frontend application by uploading a product image.

6. The application uses Amazon API Gateway REST API to invoke a pre-configured proxy Lambda function to process the visual search request.

7. Lambda function first generates the caption for the input image using the Anthropic Claude 3 Sonnet model hosted on Amazon Bedrock. Optional step for better search results. 

8. Lambda function then invokes Amazon Titan Multimodal Embeddings model hosted on Amazon Bedrock to generate the multimodal embedding based on the input image uploaded by user and the image caption (if generated in step 3).

9. Lambda function then, performs a k-NN search on the Amazon OpenSearch vector index, to find semantically similar results for the embedding generated in step 4.

10. The resultant semantic search results from Amazon Open Search are then filtered to eliminate any duplicates, enriched with product meta-data from the search index and passed back to API Gateway.

11. Finally, API Gateway response is returned to the client, to display the search results.


### Cost

_You are responsible for the cost of the AWS services used while running this Guidance. As of June 2024, the cost for running this Guidance with the default settings in the US East (N. Virginia) AWS Region is approximately $412.43 per month for processing 100,000 image searches._

_We recommend creating a [Budget](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html) through [AWS Cost Explorer](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/) to help manage costs. Prices are subject to change. For full details, refer to the pricing webpage for each AWS service used in this Guidance._

#### Sample Cost Table

The following table provides a sample cost breakdown for deploying this Guidance with the default parameters in the US East (N. Virginia) Region for one month.

| AWS service  | Dimensions | Cost [USD] |
| ----------- | ------------ | ------------ |
| Amazon API Gateway | 100,000 REST API calls per month  | $ 0.35month |
| AWS Lambda	 | 100,000 invocations per month | $ 0.68 |
| Amazon Bedrock Titan Multimodal Embeddings feature	 | 100,000 input images per month and 1200000 input tokens | $ 6.96 |
| Amazon Bedrock Anthropic Claude v3 Sonnet	 | 100,000 input images per month and 1200000 input tokens and 1200000 output tokens | $ 54.00 |
| Amazon Opensearch Serverless	 | 2 OCU(Indexing, Search and query cost) and 1GB storage | $ 350.42 |

## Prerequisites

### Operating System

These deployment instructions are optimized to best work on a pre-configured Amazon Linux 2023 AWS Cloud9 development environment. Refer to the [Individual user setup for AWS Cloud9](https://docs.aws.amazon.com/cloud9/latest/user-guide/setup-express.html) for more information on how to set up Cloud9 as a user in the AWS account. Deployment using another OS may require additional steps, and configured python libraries (see [Third-party tools](#third-party-tools)).

### Third-party tools

Before deploying the guidance code, ensure that the following required tools have been installed:

- AWS Cloud Development Kit (CDK) >= 2.126.0
- Python >= 3.8

### AWS account requirements

1. [Bedrock Model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) for Claude 3 Sonnet and Amazon Titan Multimodal embeddings

### aws cdk bootstrap

This Guidance uses AWS CDK. If you are using aws-cdk for the first time, please see the [Bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) section of the AWS Cloud Development Kit (AWS CDK) v2 developer guide, to provision the required resources, before you can deploy AWS CDK apps into an AWS environment.

## Deployment Steps

1. In the Cloud9 IDE, use the terminal to clone the repository:
    ```bash
    git clone https://github.com/aws-solutions-library-samples/guidance-for-simple-visual-search-on-aws
    ```
2. Change to the repository root folder:
    ```bash
    cd guidance-for-simple-visual-search-on-aws
    ```
3. Initialize the Python virtual environment:
    ```bash
    python3 -m venv .venv
    ```
4. Activate the virtual environment:
    ```bash
    source .venv/bin/activate
    ```
5. Install the necessary python libraries in the virtual environment:
    ```bash
    python -m pip install -r requirements.txt
    ```
6. Install the necessary node libraries in the virtual environment with your relevant package manager. For example with npm:
    ```bash
    npm install
    ```
6. Verify that the CDK deployment correctly synthesizes the CloudFormation template:
    ```bash
    cdk synth
    ```
7. Deploy the guidance:
    ```bash
    cdk deploy 
    ```

## Deployment Validation

To verify a successful deployment of this guidance, open [CloudFormation](https://console.aws.amazon.com/cloudformation/home) console, and verify that the status of the stack named `VisualSearchStack` is `CREATE_COMPLETE`.

## Running the Guidance

### Ingest products into the OpenSearch vector database
- Open AWS Console and go to Lambda
- Select the checkbox next to function prefixed with `VisualSearchStack-VisualSearchProductIngestionLamb-`
- Select "Actions"
- Select "Test"
- This will ingest the product data into Amazon OpenSearch serverless by downloading the product.json from the S3 bucket and product images from Berkeley's S3 bucket s3://amazon-berkeley-objects. It also copies the product images to the local S3 bucket.

### Do visual search

#### From UI
- Open API Gateway's 'prod' stage URL. https://xxxxx.execute-api.<region>.amazonaws.com/prod
![Search Input](/assets/search1.jpg)
- This shows a sample UI that can be used for visual search.
- Select one of the given images as input.
![Select Input Image](/assets/search2.jpg)
- Provide the API Key from the API Gateway's API Keys.
- Click on "Find visually similar products". The search results would be shown.
![Search Input](/assets/search3.jpg)


#### Through API
- Open AWS Console and go to API Gateway
- Go to the Visual Search API
- Invoke the API POST https://xxxxx.execute-api.<region>.amazonaws.com/prod/products/search by passing a JSON in the format {"content": "base64 encoded image"} 

### Sample searches
#### Sample search - Sunglasses
![Specs](/assets/search4.jpg)
#### Sample search - Suitcases
![Suitcases](/assets/search5.jpg)

## Next Steps

Several improvements can be made to make this code production ready.
- Use opensearch-py's bulk load capabilities for inserting data into the vector store for better performance.
- Use Amazon Bedrock's batch inference API during product ingestion.
- Load multiple images of a product.
- Filter the search results from OpenSearch to remove duplicates.
- Deploy the OpenSearch and Lambda in a VPC.
- Consider using Amazon Bedrock Provisioned Throughput pricing model if more capacity is needed.
- Move product ingestion code to ECS/EKS if the data set is large.

## Cleanup

To delete the deployed resources, use the AWS CDK CLI to run the following steps:

1. Using the Cloud9 terminal window, change to the root of the cloned repository:
    ```bash
    cd guidance-for-simple-visual-search-on-aws
    ```
2. Run the command to delete the CloudFormation stack:
    ```bash
    cdk destroy
    ```