import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as secretmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import * as pathlib from 'path';

export interface DatadogCostsMetricsSenderProps {
    /**
     * The Secrets Manager secret storing the Datadog API key to be
     * used for sending metrics.
     */
    apiKeySecret: secretmanager.ISecret;
    /**
     * The schedule for the Lambda function to run. If not provided, it will run nightly.
     */
    schedule?: events.Schedule;
    metricNames?: {
        /**
         * The metric name for the estimated costs accrued so far in the current month.
         */
        estimatedCosts?: string;
        /**
         * The metric name for the projected costs for the end of the current month.
         */
        projectedCosts?: string;
    };
    /**
     * The Datadog site to send the metrics to. If not provided, it will default to `datadoghq.com`.
     */
    datadogSite?: string;
}

export class DatadogCostsMetricsSender extends Construct {
    constructor(scope: Construct, identifier: string, props: DatadogCostsMetricsSenderProps) {
        super(scope, identifier);

        const handler = new lambda.Function(this, 'Handler', {
            code: lambda.Code.fromAsset(pathlib.join(__dirname, 'handler')),
            runtime: new lambda.Runtime('nodejs22.x'),
            handler: 'main.handler',
            timeout: cdk.Duration.minutes(1),
            memorySize: 128,
            environment: {
                DATADOG_API_KEY_SECRET_ARN: props.apiKeySecret.secretArn,
                DATADOG_SITE: props.datadogSite ?? 'datadoghq.com',
                ESTIMATED_COSTS_METRIC_NAME: props.metricNames?.estimatedCosts ?? 'datadog_costs.estimated',
                PROJECTED_COSTS_METRIC_NAME: props.metricNames?.projectedCosts ?? 'datadog_costs.projected',
            },
        });

        props.apiKeySecret.grantRead(handler);

        new events.Rule(this, 'ScheduleRule', {
            description: 'Event rule to run datadog-costs-metrics-sender on a schedule',
            schedule:
                props.schedule ??
                events.Schedule.cron({
                    minute: '0',
                    hour: '0',
                    day: '*',
                    month: '*',
                    year: '*',
                }),
            targets: [new eventsTargets.LambdaFunction(handler)],
        });
    }
}
