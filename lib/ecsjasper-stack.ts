import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  AwsLogDriver,
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
  Protocol,
  Secret,
  Volume,
} from "aws-cdk-lib/aws-ecs";
import { AccessPoint, FileSystem } from "aws-cdk-lib/aws-efs";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { ApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
  SubnetGroup,
} from "aws-cdk-lib/aws-rds";

// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class EcsjasperStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, "vpc", {});

    const subnetGroup = new SubnetGroup(this, "dbSubnetGroup", {
      vpc,
      description: "Private Subnets for RDS",
      subnetGroupName: "jasper-db-subnet-group",
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const sgdb = new SecurityGroup(this, "dbsg", {
      vpc,
    });

    sgdb.addIngressRule(Peer.anyIpv4(), Port.tcp(5432));

    const db = new DatabaseInstance(this, "db", {
      vpc,
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_15_4,
      }),
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      subnetGroup,
      securityGroups: [sgdb],
      databaseName: "jasper",
      credentials: Credentials.fromGeneratedSecret("jasper"),
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const cluster = new Cluster(this, "cluster", {
      vpc,
      enableFargateCapacityProviders: true,
    });

    const taskRole = new Role(this, "taskRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    const jasperTaskDef = new FargateTaskDefinition(this, "jasperTaskDef", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole,
    });

    const logging = new AwsLogDriver({ streamPrefix: "jasperreports" });

    const container = jasperTaskDef.addContainer("jasperreports", {
      image: ContainerImage.fromRegistry("bitnami/jasperreports:8.2.0"),
      environment: {
        JASPERREPORTS_DATABASE_TYPE: "postgresql",
        JASPERREPORTS_USE_ROOT_URL: "true",
      },
      secrets: {
        JASPERREPORTS_DATABASE_HOST: Secret.fromSecretsManager(
          db.secret!,
          "host",
        ),
        JASPERREPORTS_DATABASE_PORT_NUMBER: Secret.fromSecretsManager(
          db.secret!,
          "port",
        ),
        JASPERREPORTS_DATABASE_NAME: Secret.fromSecretsManager(
          db.secret!,
          "dbname",
        ),
        JASPERREPORTS_DATABASE_USER: Secret.fromSecretsManager(
          db.secret!,
          "username",
        ),
        JASPERREPORTS_DATABASE_PASSWORD: Secret.fromSecretsManager(
          db.secret!,
          "password",
        ),
      },
      logging,
      portMappings: [
        {
          containerPort: 8080,
          protocol: Protocol.TCP,
        },
      ],
    });

    const serviceSG = new SecurityGroup(this, "jasperServiceSG", {
      vpc,
    });

    const dbSG = SecurityGroup.fromSecurityGroupId(
      this,
      "importedDBSG",
      "sg-066dd26ee430ad091",
    );

    dbSG.addIngressRule(serviceSG, Port.tcp(5432));

    const service = new FargateService(this, "jasperService", {
      cluster,
      taskDefinition: jasperTaskDef,
      enableExecuteCommand: true,
      capacityProviderStrategies: [
        {
          capacityProvider: "FARGATE_SPOT",
          weight: 2,
        },
        {
          capacityProvider: "FARGATE",
          weight: 1,
        },
      ],
      desiredCount: 2,
      securityGroups: [serviceSG],
      healthCheckGracePeriod: Duration.minutes(30),
    });

    serviceSG.addIngressRule(serviceSG, Port.tcp(2049));

    const efsVol = new FileSystem(this, "efsVol", {
      vpc,
      securityGroup: serviceSG,
    });

    efsVol.grantReadWrite(taskRole);

    const accessPoint = new AccessPoint(this, "efsVolAccessPoint", {
      fileSystem: efsVol,
      path: "/bitnami/jasperreports",
      createAcl: {
        ownerGid: "1001",
        ownerUid: "1001",
        permissions: "755",
      },
      posixUser: {
        uid: "1001",
        gid: "1001",
      },
    });

    const volume: Volume = {
      name: "data",
      efsVolumeConfiguration: {
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: "ENABLED",
        },
        fileSystemId: efsVol.fileSystemId,
        transitEncryption: "ENABLED",
      },
    };

    jasperTaskDef.addVolume(volume);

    container.addMountPoints({
      sourceVolume: volume.name,
      containerPath: "/bitnami/jasperreports",
      readOnly: false,
    });

    serviceSG.addIngressRule(Peer.anyIpv4(), Port.tcp(8080));

    const alb = new ApplicationLoadBalancer(this, "alb", {
      vpc,
      internetFacing: true,
    });

    const listener = alb.addListener("albListener", { port: 80 });

    const tg = listener.addTargets("albTarget", {
      port: 80,
      targets: [
        service.loadBalancerTarget({
          containerName: "jasperreports",
          containerPort: 8080,
        }),
      ],
    });

    tg.enableCookieStickiness(Duration.days(1), "JSESSIONID");
  }
}
