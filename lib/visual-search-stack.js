/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import iam from 'aws-cdk-lib/aws-iam';
import s3 from 'aws-cdk-lib/aws-s3';
import s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import lambda from 'aws-cdk-lib/aws-lambda';
import apigateway from "aws-cdk-lib/aws-apigateway";
import triggers from 'aws-cdk-lib/triggers';
import { aws_wafv2 as wafv2 } from 'aws-cdk-lib';
import { LogGroup,RetentionDays } from 'aws-cdk-lib/aws-logs';
import events from 'aws-cdk-lib/aws-events';
import targets from 'aws-cdk-lib/aws-events-targets';
import { NagSuppressions } from 'cdk-nag';

//import { ApiGateway } from './api-gateway.js';

export class VisualSearchStack extends Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);
    
    
    function generateRandomString(length) {
      let result = '';
      const characters = 'abcdefghijklmnopqrstuvwxyz';
      const charactersLength = characters.length;
      for ( let i = 0; i < length; i++ ) {
        // nosemgrep: rule-id node_insecure_random_generator
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
      }
      let d = new Date()
      let dateSuffix = d.getDate() + "" + d.getMonth() + ""+ d.getFullYear() + "-" + d.getHours() + d.getMinutes() + d.getSeconds()
      return result + '-' + dateSuffix;
    }

    

    const S3_BUCKET_SUFFIX = generateRandomString(7);

    //bucket for access logs
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      bucketName: 'access-logs-visualsearch-bucket-' + S3_BUCKET_SUFFIX,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      enforceSSL: true,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const s3_bucket = new s3.Bucket(this, 'CreateS3Bucket', {
      bucketName: 'visualsearch-' + S3_BUCKET_SUFFIX,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      enforceSSL: true,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: 'access-logs/',
    });

    
    // Copy product feed to S3 bucket
    new s3deploy.BucketDeployment(this, 'DeployProductFeedToS3', {
      sources: [s3deploy.Source.asset('assets/s3')],
      destinationBucket: s3_bucket,
    });

    // Create a role for the lambda function which will have permissions
    // to invoke OpenSearch Serverless APIs for creating an index.
    const visualSearchIndexCreationLambdaRole = new iam.Role(this, 'visualSearchIndexCreationLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: []
    });

    visualSearchIndexCreationLambdaRole.addToPolicy(new iam.PolicyStatement({
      resources: [`arn:aws:logs:${this.region}:${this.account}:*`],
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents']
    }));

    //------------------------------------------------
    // Create a role for the lambda function which will have permissions
    // to invoke OpenSearch Serverless APIs for inserting records, invoking bedrock
    // and reading/writing from S3 bucket.
    const visualSearchProductIngestionLambdaRole = new iam.Role(this, 'visualSearchProductIngestionLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: []
    });

    visualSearchProductIngestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      resources: [`arn:aws:logs:${this.region}:${this.account}:*`],
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents']
    }));

    visualSearchProductIngestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      resources: [ s3_bucket.bucketArn ],
      actions: ['s3:GetObject', 's3:PutObject'],
      effect: iam.Effect.ALLOW
    }));

    visualSearchProductIngestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      resources: [ 
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-image-v1`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0` ],
      actions: ['bedrock:InvokeModel'],
      effect: iam.Effect.ALLOW
    }));
    //---------------------------------------------------
    // Create a role for the lambda function which will have permissions
    // to invoke OpenSearch Serverless APIs for searching records and for invoking bedrock
    const lambdaProductSearchRole = new iam.Role(this, 'lambdaProductSearchRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: []
    });

    lambdaProductSearchRole.addToPolicy(new iam.PolicyStatement({
      resources: [`arn:aws:logs:${this.region}:${this.account}:*`],
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents']
    }));

    lambdaProductSearchRole.addToPolicy(new iam.PolicyStatement({
      resources: [ 
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-image-v1`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0` ],
      actions: ['bedrock:InvokeModel'],
      effect: iam.Effect.ALLOW
    }));
    //----------------------------------------------------
    
    // Create the OpenSearch Serverless collection
    const collection = new opensearchserverless.CfnCollection(this, 'collection', {
      name: 'visualsearch',
      type: 'VECTORSEARCH'
    });
    
    // Create the OpenSearch Serverless access policy
    // Allow the Lambda role to access the collection
    const cfnAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'visualsearch-access-policy', {
      name: 'visualsearch-access-policy',
      policy: `[{"Description":"Access for cfn user","Rules":[{"ResourceType":"index","Resource":["index/visualsearch/*"],"Permission":["aoss:CreateIndex", "aoss:DescribeIndex", "aoss:ReadDocument", "aoss:WriteDocument" ]}, {"ResourceType":"collection","Resource":["collection/visualsearch"],"Permission":["aoss:CreateCollectionItems", "aoss:DescribeCollectionItems"]}], "Principal":["${visualSearchIndexCreationLambdaRole.roleArn}", "${visualSearchProductIngestionLambdaRole.roleArn}", "${lambdaProductSearchRole.roleArn}"]}]`,
      type: 'data',
      description: 'Data Access policy define how your users access the data within your collections and indexes.',
    });
    collection.addDependency(cfnAccessPolicy);
    
    const encPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'visualsearch-encryption-policy', {
        name: 'visualsearch-encryption-policy',
        policy: '{"Rules":[{"ResourceType":"collection","Resource":["collection/visualsearch"]}],"AWSOwnedKey":true}',
        type: 'encryption'
      });
    
    collection.addDependency(encPolicy);
    
    const netPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'visualsearch-network-policy', {
        name: 'visualsearch-network-policy',
        policy: '[{"Rules":[{"ResourceType":"collection","Resource":["collection/visualsearch"]}, {"ResourceType":"dashboard","Resource":["collection/visualsearch"]}],"AllowFromPublic":true}]',
        type: 'network'
      });
    
    collection.addDependency(netPolicy);

    // Add permissions in the Lambda rules for invoking OpenSearch APIs
    visualSearchIndexCreationLambdaRole.addToPolicy(new iam.PolicyStatement({
      resources: [collection.attrArn],
      actions: ['aoss:APIAccessAll','aoss:DashboardsAccessAll'],
    }));

    visualSearchProductIngestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      resources: [collection.attrArn],
      actions: ['aoss:APIAccessAll','aoss:DashboardsAccessAll'],
    }));

    lambdaProductSearchRole.addToPolicy(new iam.PolicyStatement({
      resources: [collection.attrArn],
      actions: ['aoss:APIAccessAll','aoss:DashboardsAccessAll'],
    }));
    //--------------------------------------------------------


    // Create a Lambda layer that has OpenSearch and Image libraries
    const lambdaLayer = new lambda.LayerVersion(this, "OpenSearchPillowLambdaLayer", {
      code: lambda.Code.fromAsset('lib/lambda/lambdaLayer/opensearchlibs.zip'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: "OpenSearch and Pillow libraries",
    });
    
    // Create the Lambda function that will create the OpenSearch Serverless index.
    // Download from Berkeley bucket and copy to our S3
    const lambdaIndexCreation = new lambda.Function(this, 'VisualSearchIndexCreationLambda', {
      name: 'VisualSearch-IndexCreation',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'create_index.lambda_handler',
      code: lambda.Code.fromAsset('lib/lambda/createIndex'),
      role: visualSearchIndexCreationLambdaRole,
      layers: [lambdaLayer],
      timeout: Duration.minutes(10),
      environment: {
      'OpenSearchCollectionId': `${collection.attrId}`,
      'VisualSearchS3Bucket': `${s3_bucket.bucketName}`
      },
    });
    
    lambdaIndexCreation.node.addDependency(collection);
    
    // Invoke the Lambda function to create the OpenSearch Serverless index.
    new triggers.Trigger(this, 'CreateOpenSearchIndex', {
      handler: lambdaIndexCreation,
      timeout: Duration.minutes(10),
      invocationType: triggers.InvocationType.EVENT,
      //role: lambdaRole,
    });   

    // Create the Lambda function that will ingest product feed into OpenSearch index.
    const lambdaProductIngestion = new lambda.Function(this, 'VisualSearchProductIngestionLambda', {
      name: 'VisualSearch-ProductIngestion',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'product_ingestion.lambda_handler',
      code: lambda.Code.fromAsset('lib/lambda/productIngestion'),
      layers: [lambdaLayer],
      role: visualSearchProductIngestionLambdaRole,
      timeout: Duration.minutes(15),
      environment: {
        'VisualSearchS3Bucket': `${s3_bucket.bucketName}`,
        'OpenSearchCollectionId': `${collection.attrId}`
      },
      tracing: lambda.Tracing.ACTIVE
    });

    s3_bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        resources: [
          s3_bucket.bucketArn,
          s3_bucket.bucketArn + "/*"
        ],
        actions: ["s3:GetObject"],
        principals: [new iam.ArnPrincipal(visualSearchIndexCreationLambdaRole.roleArn)]
      })
    );

    s3_bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        resources: [
          s3_bucket.bucketArn,
          s3_bucket.bucketArn + "/*"
        ],
        actions: ["s3:GetObject", "s3:PutObject"],
        principals: [new iam.ArnPrincipal(visualSearchProductIngestionLambdaRole.roleArn)]
      })
    );

    //Next create product search components like API Gwy and Lambda Function
    
    // Create the Lambda function for visual search.
    const lambdaProductSearch = new lambda.Function(this, 'VisualSearchProductSearchLambda', {
      name: 'VisualSearch-ProductSearch',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'product_search.lambda_handler',
      code: lambda.Code.fromAsset('lib/lambda/productSearch'),
      layers: [lambdaLayer],
      role: lambdaProductSearchRole,
      timeout: Duration.minutes(3),
      environment: {
        'OpenSearchCollectionId': `${collection.attrId}`
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    //create api key for api gateway
    const apiKey = new apigateway.ApiKey(this, 'ApiKey');

    const VisualSearchAPIGatewayAccessLogGroup = new LogGroup(this, 'VisualSearchAPIGatewayAccessLogGroup', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // IAM Role for API Gateway to access S3 bucket
    const apiGatewayS3Role = new iam.Role(this, 'VisualSearchAPIGatewayS3Role', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      path: '/'
    });

    s3_bucket.grantRead(apiGatewayS3Role);

    // Create the API Gateway for visual search.
    const restApi = new apigateway.RestApi(this, 'VisualSearchAPIGateway', {
      restApiName: 'VisualSearchAPIGateway',
      description: 'This API receives the base64 encoded image as input and returns the top 5 products.',
      deploy: true,
      cloudWatchRole: true,
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
      binaryMediaTypes: ['*/*'],
      deployOptions: {
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        tracingEnabled: true,
        cachingEnabled: false,
        cacheClusterEnabled: false,
        cacheDataEncrypted: false,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(VisualSearchAPIGatewayAccessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.clf(),
      },
    })

    restApi.root.addMethod("GET", new apigateway.AwsIntegration({
      apiKeyRequired: false,
      service: 's3',
      integrationHttpMethod: 'GET',
      path: `${s3_bucket.bucketName}/index.html`,
      options: {
        credentialsRole: apiGatewayS3Role,
        integrationResponses: [{
          statusCode: "200",
          responseParameters: {
            'method.response.header.Timestamp': 'integration.response.header.Date',
            'method.response.header.Content-Length': 'integration.response.header.Content-Length',
            'method.response.header.Content-Type': 'integration.response.header.Content-Type',
            'method.response.header.Access-Control-Allow-Headers': "'Content-Type,Authorization'",
            'method.response.header.Access-Control-Allow-Methods': "'GET'",
            'method.response.header.Access-Control-Allow-Origin': "'*'",
          }
        }]
      }
    }), 
    {
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Timestamp': true,
            'method.response.header.Content-Length': true,
            'method.response.header.Content-Type': true,
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
            'method.response.header.Access-Control-Allow-Origin': true,              
          },
        },
        {
          statusCode: '500',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Headers': true,
            'method.response.header.Access-Control-Allow-Methods': true,
            'method.response.header.Access-Control-Allow-Origin': true,              
          },            
        },
      ]
    });

    const requestModel = restApi.addModel('RequestModel', {
      contentType: 'application/json',
      modelName: 'RequestModel',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'imageBase64',
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          content: { type: apigateway.JsonSchemaType.STRING }
        },
        required: ['content']
      }
    });

    const productResource = restApi.root.addResource("products");
    const imagesResource = productResource.addResource("{object}");
    imagesResource.addMethod("GET", new apigateway.AwsIntegration({
      apiKeyRequired: false,
      service: 's3',
      integrationHttpMethod: 'GET',
      path: `${s3_bucket.bucketName}/images/{object}`,
      options: {
        credentialsRole: apiGatewayS3Role,
        requestParameters: {
          'integration.request.path.object': 'method.request.path.object',
          'integration.request.header.Accept': 'method.request.header.Accept',
        },
        integrationResponses: [{
          statusCode: "200",
          responseParameters: {
              'method.response.header.Timestamp': 'integration.response.header.Date',
              'method.response.header.Content-Length': 'integration.response.header.Content-Length',
              'method.response.header.Content-Type': 'integration.response.header.Content-Type',
              'method.response.header.Access-Control-Allow-Headers': "'Content-Type,Authorization'",
              'method.response.header.Access-Control-Allow-Methods': "'GET'",
              'method.response.header.Access-Control-Allow-Origin': "'*'",
            }
          },
          {
            statusCode: "400",
            responseParameters: {
              'method.response.header.Access-Control-Allow-Headers': "'Content-Type,Authorization'",
              'method.response.header.Access-Control-Allow-Methods': "'GET'",
              'method.response.header.Access-Control-Allow-Origin': "'*'"
            }
          },
          {
            statusCode: "500",
            responseParameters: {
              'method.response.header.Access-Control-Allow-Headers': "'Content-Type,Authorization'",
              'method.response.header.Access-Control-Allow-Methods': "'GET'",
              'method.response.header.Access-Control-Allow-Origin': "'*'"
            }
          }
          ]
        }
      }),
      {
        requestParameters: {          
          'method.request.path.object': true,
          'method.request.header.Accept': false
        },
        methodResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Timestamp': true,
              'method.response.header.Content-Length': true,
              'method.response.header.Content-Type': true,
              'method.response.header.Access-Control-Allow-Headers': true,
              'method.response.header.Access-Control-Allow-Methods': true,
              'method.response.header.Access-Control-Allow-Origin': true,              
            },
          },
          {
            statusCode: '400',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Headers': true,
              'method.response.header.Access-Control-Allow-Methods': true,
              'method.response.header.Access-Control-Allow-Origin': true,              
            },            
          },
          {
            statusCode: '500',
            responseParameters: {
              'method.response.header.Access-Control-Allow-Headers': true,
              'method.response.header.Access-Control-Allow-Methods': true,
              'method.response.header.Access-Control-Allow-Origin': true,              
            },            
          },
        ]
      }
    );

    // Add a policy in the S3 bucket to allow Read access to the API Gateway Role.
    s3_bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        resources: [
          s3_bucket.bucketArn,
          s3_bucket.bucketArn + "/*"
        ],
        actions: ["s3:GetObject"],
        principals: [new iam.ArnPrincipal(apiGatewayS3Role.roleArn)]
      })
    );

    // Now add "search" resource to the API Gateway.
    const searchResource = productResource.addResource("search");
    searchResource.addMethod("POST", new apigateway.LambdaIntegration(lambdaProductSearch), {
        description: 'Searches for visually similar products. Input should be in the format {"content": "<base64 encoded image>"}',
        apiKeyRequired: true,
        requestModels: {
            'application/json': requestModel
        },
        requestValidator: restApi.addRequestValidator("validate-post-request", {
          requestValidatorName: "validate-post-request",
          validateRequestBody: true,
        }) 
    });

    // Add a HTTP method to return all products
    productResource.addMethod("GET", new apigateway.LambdaIntegration(lambdaProductSearch), {
        description: 'Fetches all products',
        apiKeyRequired: true
    });

    // Add a usage plan to the API Gateway
    const usagePlan = new apigateway.UsagePlan(this, 'VisualSearchUsagePlan', {
      name: 'Visual Search Usage Plan',
      throttle: {
        rateLimit: 3,
        burstLimit: 2,
      },
      quota: {
        limit: 1000,
        period: apigateway.Period.DAY,
      },
      apiStages: [
        {
          restApi,
          stage: restApi.deploymentStage,
        },
      ],
    });

    usagePlan.addApiKey(apiKey);
    
    //eventbridge rule to trigger lambda function to ingest products
    const VisualSearchProductIngestionRule = new events.Rule(this, 'rule', {
      schedule: events.Schedule.expression('rate(1 day)'),
      targets: [new targets.LambdaFunction(lambdaProductIngestion)],
      enabled: false,
      description: 'Triggered daily to ingest products from S3 bucket',
      ruleName: 'VisualSearchProductIngestion',
    })


    // Create webacl for restapi
    
    const webACL = new wafv2.CfnWebACL(this, 'VisualSearchAPIwebACL', {
      name: 'VisualSearchAPIwebACL',
      description: 'WebACL for Visual Search APi Gateway',
      scope: 'REGIONAL', 
      defaultAction: { allow: {} }, 
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'MetricforVisualSearchAPIwebACL', 
        sampledRequestsEnabled: true,
      },
    
      rules: [
        {
          name: 'CRSRule',
          priority: 0,
          statement: {
            managedRuleGroupStatement: {
              name:'AWSManagedRulesCommonRuleSet',
              vendorName:'AWS',
              excludedRules: [{ name: 'SizeRestrictions_BODY' }],
            }
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName:'MetricforVisualSearchAPIwebACL-CRS',
            sampledRequestsEnabled: true,
          },
          overrideAction: {
            none: {}
          },
        },
      ],
    });

    const cfnWebACLAssociation = new wafv2.CfnWebACLAssociation(this, 'VisualSearchAPIwebACLAssociation', {
      webAclArn: webACL.attrArn,
      resourceArn: restApi.deploymentStage.stageArn,
    });


    //Nag Suppressions for log access
    NagSuppressions.addResourceSuppressionsByPath(this,
      ['/VisualSearchStack/lambdaProductSearchRole/DefaultPolicy/Resource',
      '/VisualSearchStack/visualSearchProductIngestionLambdaRole/DefaultPolicy/Resource',
      '/VisualSearchStack/lambdaProductSearchRole/DefaultPolicy/Resource',
      '/VisualSearchStack/visualSearchIndexCreationLambdaRole/DefaultPolicy/Resource'],
      [{ id: 'AwsSolutions-IAM5', reason: 'Required to create and write logs' }]
    );

    //Nag suppressions for CDKBucketDeployment
    NagSuppressions.addResourceSuppressionsByPath(this,
      ['/VisualSearchStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/Resource',
       '/VisualSearchStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/ServiceRole/DefaultPolicy/Resource',
       '/VisualSearchStack/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C/Resource',
       '/VisualSearchStack/VisualSearchAPIGatewayS3Role/DefaultPolicy/Resource'
      ],
      [{ id: 'AwsSolutions-IAM4', reason: 'construct created by cdk library for deployment of cdk resources' },
      { id: 'AwsSolutions-IAM5', reason: 'construct created by cdk library for deployment of cdk resources' },
      { id: 'AwsSolutions-L1', reason: 'construct created by cdk library for deployment of cdk resources' },]
    );

    //Nag suppressions for VisualSearchAPIGateway
    NagSuppressions.addResourceSuppressionsByPath(this,
      [
        '/VisualSearchStack/VisualSearchAPIGateway/Resource',
        '/VisualSearchStack/VisualSearchAPIGateway/CloudWatchRole/Resource',
        '/VisualSearchStack/VisualSearchAPIGateway/Default/products/search/POST/Resource',
        '/VisualSearchStack/VisualSearchAPIGateway/Default/products/GET/Resource',
        '/VisualSearchStack/VisualSearchAPIGateway/Default/GET/Resource',
        '/VisualSearchStack/VisualSearchAPIGateway/Default/products/{object}/GET/Resource'],
      [
        { id: 'AwsSolutions-APIG2', reason: 'request validation is enabled at method level' },
        { id: 'AwsSolutions-IAM4', reason: 'Api Gateway created role to allow writing to cloudwatch logs' },
        { id: 'AwsSolutions-APIG4', reason: 'Using Api key and WAF to secure API' },
        { id: 'AwsSolutions-COG4', reason: 'Using Api key and WAF to secure API' }
      ]
    );

  }
}