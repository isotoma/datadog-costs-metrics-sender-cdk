import * as secretsmanager from '@aws-sdk/client-secrets-manager';
import * as datadog from '@datadog/datadog-api-client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logger = (message: string, obj?: any): void => {
    console.log(
        JSON.stringify({
            message,
            ...(obj ?? {}),
        }),
    );
};

const getEnvVarOrError = (name: string): string => {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Missing environment variable: ${name}`);
    }

    return value;
};

const getEnvVarOrUndefined = (name: string): string | undefined => {
    const value = process.env[name];

    if (!value) {
        return undefined;
    }

    return value;
};

const getValueFromJsonAtPath = (json: string, path: string | undefined): string => {
    if (typeof path === 'undefined') {
        return json.trim();
    }

    const parsedJson = JSON.parse(json);
    const keys = path.split('.');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let value: any = parsedJson;
    for (const key of keys) {
        if (value[key] === undefined) {
            throw new Error(`Key not found in JSON: ${key}`);
        }
        value = value[key];
    }

    if (typeof value !== 'string') {
        throw new Error(`Value at path ${path} is not a string`);
    }

    return value;
};

const getSecretValue = async (secretArn: string, secretPath: string | undefined): Promise<string> => {
    const client = new secretsmanager.SecretsManagerClient();

    const command = new secretsmanager.GetSecretValueCommand({
        SecretId: secretArn,
    });

    try {
        const response = await client.send(command);
        if ('SecretString' in response) {
            if (secretPath) {
                return getValueFromJsonAtPath(response.SecretString, secretPath);
            }
            return response.SecretString.trim();
        } else {
            throw new Error('Secret is not a string');
        }
    } catch (error) {
        logger('Error retrieving secret', { error });
        throw new Error(`Failed to retrieve secret: ${error}`);
    }
};

const getDatadogApiConfiguration = (apiKey: string, appKey: string, site: string) => {
    logger('Creating Datadog API configuration', {
        apiKey,
        site,
    });
    const configuration = datadog.client.createConfiguration({
        authMethods: {
            apiKeyAuth: apiKey,
            appKeyAuth: appKey,
        },
    });
    configuration.setServerVariables({
        site,
    });
    return configuration;
};

const validateApiKey = async (datadogConfiguration: datadog.client.Configuration) => {
    const apiInstance = new datadog.v1.AuthenticationApi(datadogConfiguration);

    try {
        const response = await apiInstance.validate();
        logger('API key validation response', { response });
        if (response.valid) {
            logger('API key is valid');
        } else {
            logger('API key is invalid', { response });
            throw new Error('API key is invalid');
        }
    } catch (error) {
        logger('Error validating API key', { error });
        throw new Error(`Failed to validate API key: ${error}`);
    }
};

const toNaiveDate = (date: Date): Date => {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
};

const startOfMonth = (date: Date): Date => {
    const newDate = toNaiveDate(date);
    newDate.setUTCDate(1);
    return newDate;
};

const startOfNextMonth = (date: Date): Date => {
    const newDate = toNaiveDate(date);
    newDate.setUTCMonth(newDate.getUTCMonth() + 1);
    newDate.setUTCDate(1);
    return newDate;
};

const getEstimatedCosts = async (datadogConfiguration: datadog.client.Configuration, date: Date): number | undefined => {
    const apiInstance = new datadog.v2.UsageMeteringApi(datadogConfiguration);

    const params = {
        startMonth: startOfMonth(date),
        endMonth: startOfNextMonth(date),
    };

    logger('Retrieving estimated costs', { params });

    try {
        const response = await apiInstance.getEstimatedCostByOrg(params);
        const totalCost = response.data?.[0]?.attributes?.totalCost;
        return totalCost;
    } catch (error) {
        logger('Error retrieving estimated costs', { error });
        throw new Error(`Failed to retrieve estimated costs: ${error}`);
    }
};

interface DatadogMetric {
    metricName: string;
    value: number;
}

const sendMetricsToDatadog = async (datadogConfiguration: datadog.client.Configuration, date: Date, metrics: DatadogMetric[]) => {
    if (metrics.length === 0) {
        logger('No metrics to send to Datadog');
        return;
    }

    const apiInstance = new datadog.v2.MetricsApi(datadogConfiguration);
    const params: datadog.v2.MetricsApiSubmitMetricsRequest = {
        body: {
            series: metrics.map((metric) => ({
                metric: metric.metricName,
                type: 0,
                points: [
                    {
                        timestamp: Math.round(date.getTime() / 1000),
                        value: metric.value,
                    },
                ],
                unit: 'dollar',
            })),
        },
    };

    logger('Sending metrics to Datadog', { params });

    try {
        const response = await apiInstance.submitMetrics(params);
        if (response.errors && response.errors.length > 0) {
            logger('Errors sending metrics to Datadog', { errors: response.errors });
            throw new Error(`Errors sending metrics to Datadog: ${response.errors}`);
        }
    } catch (error) {
        logger('Error sending metrics to Datadog', { error });
        throw new Error(`Failed to send metrics to Datadog: ${error}`);
    }
};

const getProjectedCosts = async (datadogConfiguration: datadog.client.Configuration): number | undefined => {
    const apiInstance = new datadog.v2.UsageMeteringApi(datadogConfiguration);

    try {
        const response = await apiInstance.getProjectedCost();
        const totalCost = response.data?.[0]?.attributes?.projectedTotalCost;
        return totalCost;
    } catch (error) {
        logger('Error retrieving projected costs', { error });
        throw new Error(`Failed to retrieve projected costs: ${error}`);
    }
};

export const handler = async () => {
    logger('Starting');

    const datadogApiKeySecretArn = getEnvVarOrError('DATADOG_API_KEY_SECRET_ARN');
    const datadogApiKeySecretPath = getEnvVarOrUndefined('DATADOG_API_KEY_SECRET_PATH');
    const datadogAppKeySecretArn = getEnvVarOrError('DATADOG_APP_KEY_SECRET_ARN');
    const datadogAppKeySecretPath = getEnvVarOrUndefined('DATADOG_APP_KEY_SECRET_PATH');
    const datadogSite = getEnvVarOrError('DATADOG_SITE');
    const estimatedCostsMetricName = getEnvVarOrError('ESTIMATED_COSTS_METRIC_NAME');
    const projectedCostsMetricName = getEnvVarOrError('PROJECTED_COSTS_METRIC_NAME');

    logger('Configuration retrieved from variables', {
        datadogApiKeySecretArn,
        datadogApiKeySecretPath,
        datadogAppKeySecretArn,
        datadogAppKeySecretPath,
        datadogSite,
        estimatedCostsMetricName,
        projectedCostsMetricName,
    });

    const datadogApiKey = await getSecretValue(datadogApiKeySecretArn, datadogApiKeySecretPath);
    const datadogAppKey = await getSecretValue(datadogAppKeySecretArn, datadogAppKeySecretPath);

    logger('Datadog API key and app key retrieved', {
        datadogApiKey,
        datadogAppKey,
        datadogSite,
    });

    const datadogConfiguration = getDatadogApiConfiguration(datadogApiKey, datadogAppKey, datadogSite);

    await validateApiKey(datadogConfiguration);

    const date = new Date();

    const metrics = [];

    const estimatedCosts = await getEstimatedCosts(datadogConfiguration, date);
    logger('Estimated costs', { estimatedCosts });
    if (estimatedCosts !== undefined) {
        metrics.push({
            metricName: estimatedCostsMetricName,
            value: estimatedCosts,
        });
    }
    const projectedCosts = await getProjectedCosts(datadogConfiguration);
    logger('Projected costs', { projectedCosts });
    if (projectedCosts !== undefined) {
        metrics.push({
            metricName: projectedCostsMetricName,
            value: projectedCosts,
        });
    }

    await sendMetricsToDatadog(datadogConfiguration, date, metrics);
};
