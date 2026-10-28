import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as events from 'aws-cdk-lib/aws-events';
import * as secretmanager from 'aws-cdk-lib/aws-secretsmanager';

import { DatadogCostsMetricsSender } from '../index';

const synth = (props?: {
    apiKeySecretPath?: Array<string>;
    appKeySecretPath?: Array<string>;
    schedule?: events.Schedule;
    metricNames?: { estimatedCosts?: string; projectedCosts?: string };
    datadogSite?: string;
}): Template => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const apiKeySecret = new secretmanager.Secret(stack, 'ApiKeySecret');
    const appKeySecret = new secretmanager.Secret(stack, 'AppKeySecret');

    new DatadogCostsMetricsSender(stack, 'Sender', {
        apiKeySecret,
        appKeySecret,
        ...props,
    });

    return Template.fromStack(stack);
};

describe('DatadogCostsMetricsSender', () => {
    test('runs the handler on a supported Lambda runtime', () => {
        synth().hasResourceProperties('AWS::Lambda::Function', {
            Runtime: 'nodejs22.x',
            Handler: 'main.handler',
            Timeout: 60,
            MemorySize: 128,
        });
    });

    test('defaults the Datadog site and metric names', () => {
        synth().hasResourceProperties('AWS::Lambda::Function', {
            Environment: {
                Variables: Match.objectLike({
                    DATADOG_SITE: 'datadoghq.com',
                    ESTIMATED_COSTS_METRIC_NAME: 'datadog_costs.estimated',
                    PROJECTED_COSTS_METRIC_NAME: 'datadog_costs.projected',
                }),
            },
        });
    });

    test('applies overrides and secret paths', () => {
        synth({
            datadogSite: 'datadoghq.eu',
            metricNames: { estimatedCosts: 'custom.estimated', projectedCosts: 'custom.projected' },
            apiKeySecretPath: ['datadog', 'apiKey'],
            appKeySecretPath: ['datadog', 'appKey'],
        }).hasResourceProperties('AWS::Lambda::Function', {
            Environment: {
                Variables: Match.objectLike({
                    DATADOG_SITE: 'datadoghq.eu',
                    ESTIMATED_COSTS_METRIC_NAME: 'custom.estimated',
                    PROJECTED_COSTS_METRIC_NAME: 'custom.projected',
                    DATADOG_API_KEY_SECRET_PATH: 'datadog.apiKey',
                    DATADOG_APP_KEY_SECRET_PATH: 'datadog.appKey',
                }),
            },
        });
    });

    test('schedules the handler nightly by default', () => {
        synth().hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: 'cron(0 0 * * ? *)',
            Targets: Match.arrayWith([
                Match.objectLike({
                    Arn: Match.anyValue(),
                }),
            ]),
        });
    });

    test('honours a custom schedule', () => {
        synth({ schedule: events.Schedule.rate(Duration.hours(6)) }).hasResourceProperties('AWS::Events::Rule', {
            ScheduleExpression: 'rate(6 hours)',
        });
    });
});
