import {
  DescribeOrganizationCommand,
  ListRootsCommand,
  OrganizationsClient,
  OrganizationFeatureSet,
  OrganizationalUnit,
  paginateListAccounts,
  paginateListOrganizationalUnitsForParent,
  EnableAllFeaturesCommand,
  Account,
  AWSOrganizationsNotInUseException,
  paginateListAWSServiceAccessForOrganization,
  EnabledServicePrincipal,
} from '@aws-sdk/client-organizations';
import { InstanceMetadata, paginateListInstances, SSOAdminClient } from '@aws-sdk/client-sso-admin';
import * as winston from 'winston';
import { createLogger, setRetryStrategy, throttlingBackOff } from '@aws-accelerator/utils';
import path from 'path';
import { OrganizationRootType } from '../utils/resources';

/**
 * Organization abstract class to get AWS Organizations details and create AWS Organizations if not exists
 */
export abstract class Organization {
  private static logger: winston.Logger = createLogger([path.parse(path.basename(__filename)).name]);

  /**
   * Function to check if AWS Organizations is configured
   * @param client {@link OrganizationsClient}
   * @returns status boolean
   */
  private static async isOrganizationNotConfigured(client: OrganizationsClient): Promise<boolean> {
    try {
      const response = await throttlingBackOff(() => client.send(new DescribeOrganizationCommand({})));

      if (response.Organization?.Id) {
        Organization.logger.info(`AWS Organizations already configured`);
        return false;
      }
      return true;
    } catch (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      e: any
    ) {
      if (e instanceof AWSOrganizationsNotInUseException) {
        return true;
      }
      throw e;
    }
  }
  /**
   * Function to get list of services enabled in AWS Organizations
   * @param client {@link OrganizationsClient}
   * @returns enabledServicePrincipals {@link EnabledServicePrincipal}[]
   */
  private static async getOrganizationEnabledServices(client: OrganizationsClient): Promise<EnabledServicePrincipal[]> {
    const enabledServicePrincipals: EnabledServicePrincipal[] = [];

    const paginator = paginateListAWSServiceAccessForOrganization({ client }, {});
    for await (const page of paginator) {
      for (const enabledServicePrincipal of page.EnabledServicePrincipals ?? []) {
        enabledServicePrincipals.push(enabledServicePrincipal);
      }
    }
    return enabledServicePrincipals;
  }

  /**
   * Function to check if any services are enabled in AWS Organizations
   * @param client {@link OrganizationsClient}
   * @returns status boolean
   */
  private static async isAnyOrganizationServiceEnabled(client: OrganizationsClient): Promise<boolean> {
    const enabledServicePrincipals = await this.getOrganizationEnabledServices(client);
    if (enabledServicePrincipals.length > 0) {
      Organization.logger.warn(
        `AWS Organizations have multiple services enabled "${enabledServicePrincipals
          .map(item => item.ServicePrincipal)
          .join(',')}", the solution cannot deploy AWS Control Tower Landing Zone.`,
      );
      return true;
    }

    return false;
  }

  /**
   * Function to check if AWS Organizations have any organizational units
   * @param client {@link OrganizationsClient}
   * @returns status boolean
   */
  private static async isOrganizationsHaveOrganizationalUnits(client: OrganizationsClient): Promise<boolean> {
    const organizationalUnitsForRoot = await Organization.getOrganizationalUnitsForRoot(client);

    if (organizationalUnitsForRoot.length !== 0) {
      Organization.logger.warn(
        `AWS Organizations have multiple organization units "${organizationalUnitsForRoot
          .map(item => item.Name)
          .join(',')}", the solution cannot deploy AWS Control Tower Landing Zone.`,
      );
      return true;
    }

    return false;
  }

  /**
   * Function to check if AWS Organizations have any accounts other than management account.
   * @param client {@link OrganizationsClient}
   * @returns status boolean
   */
  private static async isOrganizationHaveAdditionalAccounts(client: OrganizationsClient): Promise<boolean> {
    const accounts = await Organization.getOrganizationAccounts(client);
    if (accounts.length > 1) {
      Organization.logger.warn(
        `AWS Organizations have multiple accounts "${accounts
          .map(account => account.Name + ' -> ' + account.Email)
          .join(',')}", the solution cannot deploy AWS Control Tower Landing Zone.`,
      );
      return true;
    }
    return false;
  }

  /**
   * Function to get list of the AWS IAM Identity Center instances
   * @param region string
   * @param solutionId string
   * @returns instances {@link InstanceMetadata}[]
   */
  private static async getIdentityCenterInstances(region: string, solutionId: string): Promise<InstanceMetadata[]> {
    const client = new SSOAdminClient({ region, customUserAgent: solutionId, retryStrategy: setRetryStrategy() });
    const instances: InstanceMetadata[] = [];

    const paginator = paginateListInstances({ client }, {});
    for await (const page of paginator) {
      for (const instance of page.Instances ?? []) {
        instances.push(instance);
      }
    }
    return instances;
  }

  /**
   * Function to check if IAM Identity Center is enabled
   * @param region string
   * @param solutionId string
   * @returns status boolean
   */
  private static async isIdentityCenterEnabled(region: string, solutionId: string): Promise<boolean> {
    const instances = await Organization.getIdentityCenterInstances(region, solutionId);
    if (instances.length > 0) {
      Organization.logger.warn(
        `AWS Organizations have IAM Identity Center enabled "${instances
          .map(instance => instance.IdentityStoreId)
          .join(',')}", the solution cannot deploy AWS Control Tower Landing Zone.`,
      );
      return true;
    }
    return false;
  }

  /**
   * Function to get list of organization for given parent
   * @param client {@link OrganizationsClient}
   * @param parentId string
   * @returns organizationalUnits {@link OrganizationalUnit}[]
   */
  private static async getOrganizationalUnitsForParent(
    client: OrganizationsClient,
    parentId: string,
  ): Promise<OrganizationalUnit[]> {
    const organizationalUnits: OrganizationalUnit[] = [];

    const paginator = paginateListOrganizationalUnitsForParent({ client }, { ParentId: parentId });
    for await (const page of paginator) {
      for (const organizationalUnit of page.OrganizationalUnits ?? []) {
        organizationalUnits.push(organizationalUnit);
      }
    }
    return organizationalUnits;
  }

  /**
   * Function to get Organizational units for root
   *
   * @param client {@link OrganizationsClient}
   */
  private static async getOrganizationalUnitsForRoot(
    client: OrganizationsClient,
    rootId?: string,
  ): Promise<OrganizationalUnit[]> {
    const parentId = rootId ?? (await Organization.getOrganizationsRoot(client)).Id;
    return await Organization.getOrganizationalUnitsForParent(client, parentId);
  }

  /**
   * Function to get AWS Organizations Root details
   *
   * @param client {@link OrganizationsClient}
   * @returns organizationRoot {@link OrganizationRootType}
   */
  public static async getOrganizationsRoot(client: OrganizationsClient): Promise<OrganizationRootType> {
    const response = await throttlingBackOff(() => client.send(new ListRootsCommand({})));
    return { Name: response.Roots![0].Name!, Id: response.Roots![0].Id! };
  }

  /**
   * Function to enable all features for AWS Organization if not enabled already.
   * @param client {@link OrganizationsClient}
   */
  private static async enableOrganizationsAllFeature(client: OrganizationsClient): Promise<void> {
    const response = await throttlingBackOff(() => client.send(new DescribeOrganizationCommand({})));
    if (response.Organization?.FeatureSet !== OrganizationFeatureSet.ALL) {
      Organization.logger.warn(
        `The existing AWS Organization ${response.Organization?.Id} does not have all features enabled. The solution will update your organization so that all features are enabled.`,
      );
      await throttlingBackOff(() => client.send(new EnableAllFeaturesCommand({})));
    }
  }

  /**
   * Function to retrieve AWS organizations accounts
   * @param client {@link OrganizationsClient}
   * @returns accounts {@link Account}[]
   */
  public static async getOrganizationAccounts(client: OrganizationsClient): Promise<Account[]> {
    const organizationAccounts: Account[] = [];
    const paginator = paginateListAccounts({ client }, {});
    for await (const page of paginator) {
      for (const account of page.Accounts ?? []) {
        organizationAccounts.push(account);
      }
    }
    return organizationAccounts;
  }

  /**
   * Function to get management account id
   * @param email string
   * @returns accountId string
   */
  public static async getManagementAccountId(globalRegion: string, solutionId: string, email: string): Promise<string> {
    const client: OrganizationsClient = new OrganizationsClient({
      region: globalRegion,
      customUserAgent: solutionId,
      retryStrategy: setRetryStrategy(),
    });
    const accounts = await Organization.getOrganizationAccounts(client);

    for (const account of accounts) {
      if (account.Id && account.Email === email) {
        return account.Id;
      }
    }
    throw new Error(`Management account with email ${email} not found`);
  }

  /**
   * Function to validate AWS Organizations
   *
   * @param globalRegion string
   * @param region string
   * @param solutionId string
   */
  public static async ValidateOrganization(globalRegion: string, region: string, solutionId: string): Promise<void> {
    const client: OrganizationsClient = new OrganizationsClient({
      region: globalRegion,
      customUserAgent: solutionId,
      retryStrategy: setRetryStrategy(),
    });

    const validationErrors: string[] = [];

    if (await Organization.isIdentityCenterEnabled(region, solutionId)) {
      validationErrors.push(`AWS Control Tower Landing Zone cannot deploy because IAM Identity Center is configured.`);
    }

    if (await Organization.isOrganizationNotConfigured(client)) {
      validationErrors.push(
        `AWS Control Tower Landing Zone cannot deploy because AWS Organizations have not been configured for the environment.`,
      );
    } else {
      if (await Organization.isAnyOrganizationServiceEnabled(client)) {
        validationErrors.push(
          `AWS Control Tower Landing Zone cannot deploy because AWS Organizations have services enabled.`,
        );
      }

      if (await Organization.isOrganizationsHaveOrganizationalUnits(client)) {
        validationErrors.push(
          `AWS Control Tower Landing Zone cannot deploy because there are multiple organizational units in AWS Organizations.`,
        );
      }

      if (await Organization.isOrganizationHaveAdditionalAccounts(client)) {
        validationErrors.push(
          `AWS Control Tower Landing Zone cannot deploy because there are multiple accounts in AWS Organizations.`,
        );
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(
        `AWS Organization validation has ${validationErrors.length} issue(s):\n${validationErrors.join('\n')}`,
      );
    }

    await Organization.enableOrganizationsAllFeature(client);
  }
}
