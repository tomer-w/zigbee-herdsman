/* istanbul ignore file */

import assert from 'assert';

import {ZSpec} from '../../..';
import Device from '../../../controller/model/device';
import * as Models from '../../../models';
import {Queue, Waitress} from '../../../utils';
import {logger} from '../../../utils/logger';
import {BroadcastAddress} from '../../../zspec/enums';
import * as Zcl from '../../../zspec/zcl';
import Adapter from '../../adapter';
import * as Events from '../../events';
import {
    ActiveEndpoints,
    AdapterOptions,
    Coordinator,
    CoordinatorVersion,
    DeviceType,
    LQI,
    LQINeighbor,
    NetworkOptions,
    NetworkParameters,
    NodeDescriptor,
    RoutingTable,
    RoutingTableEntry,
    SerialPortOptions,
    SimpleDescriptor,
    StartResult,
} from '../../tstype';
import PARAM, {ApsDataRequest, gpDataInd, ReceivedDataResponse, WaitForDataRequest} from '../driver/constants';
import Driver from '../driver/driver';
import processFrame, {frameParserEvents} from '../driver/frameParser';

const NS = 'zh:deconz';

interface WaitressMatcher {
    address?: number | string;
    endpoint: number;
    transactionSequenceNumber?: number;
    frameType: Zcl.FrameType;
    clusterID: number;
    commandIdentifier: number;
    direction: number;
}

class DeconzAdapter extends Adapter {
    private driver: Driver;
    private queue: Queue;
    private openRequestsQueue: WaitForDataRequest[];
    private transactionID: number;
    private frameParserEvent = frameParserEvents;
    private joinPermitted: boolean;
    private fwVersion?: CoordinatorVersion;
    private waitress: Waitress<Events.ZclPayload, WaitressMatcher>;
    private TX_OPTIONS = 0x00; // No APS ACKS

    public constructor(networkOptions: NetworkOptions, serialPortOptions: SerialPortOptions, backupPath: string, adapterOptions: AdapterOptions) {
        super(networkOptions, serialPortOptions, backupPath, adapterOptions);

        const concurrent = this.adapterOptions && this.adapterOptions.concurrent ? this.adapterOptions.concurrent : 2;

        // TODO: https://github.com/Koenkk/zigbee2mqtt/issues/4884#issuecomment-728903121
        const delay = this.adapterOptions && typeof this.adapterOptions.delay === 'number' ? this.adapterOptions.delay : 0;

        this.waitress = new Waitress<Events.ZclPayload, WaitressMatcher>(this.waitressValidator, this.waitressTimeoutFormatter);

        this.driver = new Driver(serialPortOptions.path!);
        this.driver.setDelay(delay);

        if (delay >= 200) {
            this.TX_OPTIONS = 0x04; // activate APS ACKS
        }

        this.driver.on('rxFrame', (frame) => {
            processFrame(frame);
        });
        this.queue = new Queue(concurrent);
        this.transactionID = 0;
        this.openRequestsQueue = [];
        this.joinPermitted = false;
        this.fwVersion = undefined;

        this.frameParserEvent.on('receivedDataPayload', (data) => {
            this.checkReceivedDataPayload(data);
        });
        this.frameParserEvent.on('receivedGreenPowerIndication', (data) => {
            this.checkReceivedGreenPowerIndication(data);
        });

        setInterval(() => {
            this.checkReceivedDataPayload(null);
        }, 1000);
        setTimeout(async () => {
            await this.checkCoordinatorSimpleDescriptor(false);
        }, 3000);
    }

    public static async isValidPath(path: string): Promise<boolean> {
        return Driver.isValidPath(path);
    }

    public static async autoDetectPath(): Promise<string | undefined> {
        return Driver.autoDetectPath();
    }

    /**
     * Adapter methods
     */
    public async start(): Promise<StartResult> {
        const baudrate = this.serialPortOptions.baudRate || 38400;
        await this.driver.open(baudrate);

        let changed: boolean = false;
        const panid = await this.driver.readParameterRequest(PARAM.PARAM.Network.PAN_ID);
        const expanid = await this.driver.readParameterRequest(PARAM.PARAM.Network.APS_EXT_PAN_ID);
        const channel = await this.driver.readParameterRequest(PARAM.PARAM.Network.CHANNEL);
        const networkKey = await this.driver.readParameterRequest(PARAM.PARAM.Network.NETWORK_KEY);

        // check current channel against configuration.yaml
        if (this.networkOptions.channelList[0] !== channel) {
            logger.debug(
                'Channel in configuration.yaml (' +
                    this.networkOptions.channelList[0] +
                    ') differs from current channel (' +
                    channel +
                    '). Changing channel.',
                NS,
            );

            let setChannelMask = 0;
            switch (this.networkOptions.channelList[0]) {
                case 11:
                    setChannelMask = 0x800;
                    break;
                case 12:
                    setChannelMask = 0x1000;
                    break;
                case 13:
                    setChannelMask = 0x2000;
                    break;
                case 14:
                    setChannelMask = 0x4000;
                    break;
                case 15:
                    setChannelMask = 0x8000;
                    break;
                case 16:
                    setChannelMask = 0x10000;
                    break;
                case 17:
                    setChannelMask = 0x20000;
                    break;
                case 18:
                    setChannelMask = 0x40000;
                    break;
                case 19:
                    setChannelMask = 0x80000;
                    break;
                case 20:
                    setChannelMask = 0x100000;
                    break;
                case 21:
                    setChannelMask = 0x200000;
                    break;
                case 22:
                    setChannelMask = 0x400000;
                    break;
                case 23:
                    setChannelMask = 0x800000;
                    break;
                case 24:
                    setChannelMask = 0x1000000;
                    break;
                case 25:
                    setChannelMask = 0x2000000;
                    break;
                case 26:
                    setChannelMask = 0x4000000;
                    break;
                default:
                    break;
            }

            try {
                await this.driver.writeParameterRequest(PARAM.PARAM.Network.CHANNEL_MASK, setChannelMask);
                await this.sleep(500);
                changed = true;
            } catch (error) {
                logger.debug('Could not set channel: ' + error, NS);
            }
        }

        // check current panid against configuration.yaml
        if (this.networkOptions.panID !== panid) {
            logger.debug(
                'panid in configuration.yaml (' + this.networkOptions.panID + ') differs from current panid (' + panid + '). Changing panid.',
                NS,
            );

            try {
                await this.driver.writeParameterRequest(PARAM.PARAM.Network.PAN_ID, this.networkOptions.panID);
                await this.sleep(500);
                changed = true;
            } catch (error) {
                logger.debug('Could not set panid: ' + error, NS);
            }
        }

        // check current extended_panid against configuration.yaml
        if (this.driver.generalArrayToString(this.networkOptions.extendedPanID!, 8) !== expanid) {
            logger.debug(
                'extended panid in configuration.yaml (' +
                    this.driver.macAddrArrayToString(this.networkOptions.extendedPanID!) +
                    ') differs from current extended panid (' +
                    expanid +
                    '). Changing extended panid.',
                NS,
            );

            try {
                await this.driver.writeParameterRequest(PARAM.PARAM.Network.APS_EXT_PAN_ID, this.networkOptions.extendedPanID!);
                await this.sleep(500);
                changed = true;
            } catch (error) {
                logger.debug('Could not set extended panid: ' + error, NS);
            }
        }

        // check current network key against configuration.yaml
        if (this.driver.generalArrayToString(this.networkOptions.networkKey!, 16) !== networkKey) {
            logger.debug(
                'network key in configuration.yaml (hidden) differs from current network key (' + networkKey + '). Changing network key.',
                NS,
            );

            try {
                await this.driver.writeParameterRequest(PARAM.PARAM.Network.NETWORK_KEY, this.networkOptions.networkKey!);
                await this.sleep(500);
                changed = true;
            } catch (error) {
                logger.debug('Could not set network key: ' + error, NS);
            }
        }

        if (changed) {
            await this.driver.changeNetworkStateRequest(PARAM.PARAM.Network.NET_OFFLINE);
            await this.sleep(2000);
            await this.driver.changeNetworkStateRequest(PARAM.PARAM.Network.NET_CONNECTED);
            await this.sleep(2000);
        }

        return 'resumed';
    }

    public async stop(): Promise<void> {
        await this.driver.close();
    }

    public async getCoordinator(): Promise<Coordinator> {
        const ieeeAddr = await this.driver.readParameterRequest(PARAM.PARAM.Network.MAC);
        const nwkAddr = await this.driver.readParameterRequest(PARAM.PARAM.Network.NWK_ADDRESS);

        const endpoints = [
            {
                ID: 0x01,
                profileID: 0x0104,
                deviceID: 0x0005,
                inputClusters: [0x0000, 0x0006, 0x000a, 0x0019, 0x0501],
                outputClusters: [0x0001, 0x0020, 0x0500, 0x0502],
            },
            {
                ID: 0xf2,
                profileID: 0xa1e0,
                deviceID: 0x0064,
                inputClusters: [],
                outputClusters: [0x0021],
            },
        ];

        return {
            networkAddress: nwkAddr as number,
            manufacturerID: 0x1135,
            ieeeAddr: ieeeAddr as string,
            endpoints,
        };
    }

    public async permitJoin(seconds: number, networkAddress?: number): Promise<void> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID, seconds, 0]; // tc_significance 1 or 0 ?

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress || 0xfffc;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x36; // permit join
        request.srcEndpoint = 0;
        request.asduLength = 3;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 5;

        try {
            await this.driver.enqueueSendDataRequest(request);
            if (seconds === 0) {
                this.joinPermitted = false;
            } else {
                this.joinPermitted = true;
            }
            await this.driver.writeParameterRequest(PARAM.PARAM.Network.PERMIT_JOIN, seconds);

            logger.debug('PERMIT_JOIN - ' + seconds + ' seconds', NS);
        } catch (error) {
            const msg = 'PERMIT_JOIN FAILED - ' + error;
            logger.debug(msg, NS);
            // try again
            await this.permitJoin(seconds, networkAddress);
            //return Promise.reject(new Error(msg)); // do not reject
        }
    }

    public async getCoordinatorVersion(): Promise<CoordinatorVersion> {
        // product: number; transportrev: number; majorrel: number; minorrel: number; maintrel: number; revision: string;
        if (this.fwVersion != undefined) {
            return this.fwVersion;
        } else {
            try {
                const fw = await this.driver.readFirmwareVersionRequest();
                const buf = Buffer.from(fw);
                const fwString = '0x' + buf.readUInt32LE(0).toString(16);
                let type: string = '';
                if (fw[1] === 5) {
                    type = 'ConBee/RaspBee';
                } else if (fw[1] === 7) {
                    type = 'ConBee2/RaspBee2';
                } else {
                    type = 'ConBee3';
                }
                const meta = {transportrev: 0, product: 0, majorrel: fw[3], minorrel: fw[2], maintrel: 0, revision: fwString};
                this.fwVersion = {type: type, meta: meta};
                return {type: type, meta: meta};
            } catch (error) {
                throw new Error('Get coordinator version Error: ' + error);
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async addInstallCode(ieeeAddress: string, key: Buffer): Promise<void> {
        return Promise.reject(new Error('Add install code is not supported'));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async reset(type: 'soft' | 'hard'): Promise<void> {
        return Promise.reject(new Error('Reset is not supported'));
    }

    public async lqi(networkAddress: number): Promise<LQI> {
        const neighbors: LQINeighbor[] = [];

        const add = (list: Buffer[]): void => {
            for (const entry of list) {
                const relationByte = entry.readUInt8(18);
                const extAddr: number[] = [];
                for (let i = 8; i < 16; i++) {
                    extAddr.push(entry[i]);
                }

                neighbors.push({
                    linkquality: entry.readUInt8(21),
                    networkAddress: entry.readUInt16LE(16),
                    ieeeAddr: this.driver.macAddrArrayToString(extAddr),
                    relationship: (relationByte >> 1) & ((1 << 3) - 1),
                    depth: entry.readUInt8(20),
                });
            }
        };

        const request = async (
            startIndex: number,
        ): Promise<{
            status: number;
            tableEntrys: number;
            startIndex: number;
            tableListCount: number;
            tableList: Buffer[];
        }> => {
            const transactionID = this.nextTransactionID();
            const req: ApsDataRequest = {};
            req.requestId = transactionID;
            req.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
            req.destAddr16 = networkAddress;
            req.destEndpoint = 0;
            req.profileId = 0;
            req.clusterId = 0x31; // mgmt_lqi_request
            req.srcEndpoint = 0;
            req.asduLength = 2;
            req.asduPayload = [transactionID, startIndex];
            req.txOptions = 0;
            req.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;

            this.driver
                .enqueueSendDataRequest(req)
                .then(() => {})
                .catch(() => {});

            try {
                const d = await this.waitForData(networkAddress, 0, 0x8031);
                const data = d.asduPayload!;

                if (data[1] !== 0) {
                    // status
                    throw new Error(`LQI for '${networkAddress}' failed`);
                }
                const tableList: Buffer[] = [];
                const response = {
                    status: data[1],
                    tableEntrys: data[2],
                    startIndex: data[3],
                    tableListCount: data[4],
                    tableList: tableList,
                };

                let tableEntry: number[] = [];
                let counter = 0;
                for (let i = 5; i < response.tableListCount * 22 + 5; i++) {
                    // one tableentry = 22 bytes
                    tableEntry.push(data[i]);
                    counter++;
                    if (counter === 22) {
                        response.tableList.push(Buffer.from(tableEntry));
                        tableEntry = [];
                        counter = 0;
                    }
                }

                logger.debug(
                    'LQI RESPONSE - addr: 0x' +
                        networkAddress.toString(16) +
                        ' status: ' +
                        response.status +
                        ' read ' +
                        (response.tableListCount + response.startIndex) +
                        '/' +
                        response.tableEntrys +
                        ' entrys',
                    NS,
                );
                return response;
            } catch (error) {
                const msg = 'LQI REQUEST FAILED - addr: 0x' + networkAddress.toString(16) + ' ' + error;
                logger.debug(msg, NS);
                return Promise.reject(new Error(msg));
            }
        };

        let response = await request(0);
        add(response.tableList);
        let nextStartIndex = response.tableListCount;

        while (neighbors.length < response.tableEntrys) {
            response = await request(nextStartIndex);
            add(response.tableList);
            nextStartIndex += response.tableListCount;
        }

        return {neighbors};
    }

    public async routingTable(networkAddress: number): Promise<RoutingTable> {
        const table: RoutingTableEntry[] = [];
        const statusLookup: {[n: number]: string} = {
            0: 'ACTIVE',
            1: 'DISCOVERY_UNDERWAY',
            2: 'DISCOVERY_FAILED',
            3: 'INACTIVE',
        };
        const add = (list: Buffer[]): void => {
            for (const entry of list) {
                const statusByte = entry.readUInt8(2);
                const extAddr: number[] = [];
                for (let i = 8; i < 16; i++) {
                    extAddr.push(entry[i]);
                }

                table.push({
                    destinationAddress: entry.readUInt16LE(0),
                    status: statusLookup[(statusByte >> 5) & ((1 << 3) - 1)],
                    nextHop: entry.readUInt16LE(3),
                });
            }
        };

        const request = async (
            startIndex: number,
        ): Promise<{
            status: number;
            tableEntrys: number;
            startIndex: number;
            tableListCount: number;
            tableList: Buffer[];
        }> => {
            const transactionID = this.nextTransactionID();
            const req: ApsDataRequest = {};
            req.requestId = transactionID;
            req.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
            req.destAddr16 = networkAddress;
            req.destEndpoint = 0;
            req.profileId = 0;
            req.clusterId = 0x32; // mgmt_rtg_request
            req.srcEndpoint = 0;
            req.asduLength = 2;
            req.asduPayload = [transactionID, startIndex];
            req.txOptions = 0;
            req.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
            req.timeout = 30;

            this.driver
                .enqueueSendDataRequest(req)
                .then(() => {})
                .catch(() => {});

            try {
                const d = await this.waitForData(networkAddress, 0, 0x8032);
                const data = d.asduPayload!;

                if (data[1] !== 0) {
                    // status
                    throw new Error(`Routingtables for '${networkAddress}' failed`);
                }
                const tableList: Buffer[] = [];
                const response = {
                    status: data[1],
                    tableEntrys: data[2],
                    startIndex: data[3],
                    tableListCount: data[4],
                    tableList: tableList,
                };

                let tableEntry: number[] = [];
                let counter = 0;
                for (let i = 5; i < response.tableListCount * 5 + 5; i++) {
                    // one tableentry = 5 bytes
                    tableEntry.push(data[i]);
                    counter++;
                    if (counter === 5) {
                        response.tableList.push(Buffer.from(tableEntry));
                        tableEntry = [];
                        counter = 0;
                    }
                }

                logger.debug(
                    'ROUTING_TABLE RESPONSE - addr: 0x' +
                        networkAddress.toString(16) +
                        ' status: ' +
                        response.status +
                        ' read ' +
                        (response.tableListCount + response.startIndex) +
                        '/' +
                        response.tableEntrys +
                        ' entrys',
                    NS,
                );
                return response;
            } catch (error) {
                const msg = 'ROUTING_TABLE REQUEST FAILED - addr: 0x' + networkAddress.toString(16) + ' ' + error;
                logger.debug(msg, NS);
                return Promise.reject(new Error(msg));
            }
        };

        let response = await request(0);
        add(response.tableList);
        let nextStartIndex = response.tableListCount;

        while (table.length < response.tableEntrys) {
            response = await request(nextStartIndex);
            add(response.tableList);
            nextStartIndex += response.tableListCount;
        }

        return {table};
    }

    public async nodeDescriptor(networkAddress: number): Promise<NodeDescriptor> {
        const transactionID = this.nextTransactionID();
        const nwk1 = networkAddress & 0xff;
        const nwk2 = (networkAddress >> 8) & 0xff;
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID, nwk1, nwk2];

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x02; // node descriptor
        request.srcEndpoint = 0;
        request.asduLength = 3;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver
            .enqueueSendDataRequest(request)
            .then(() => {})
            .catch(() => {});

        try {
            const d = await this.waitForData(networkAddress, 0, 0x8002);
            const data = d.asduPayload!;

            const buf = Buffer.from(data);
            const logicaltype = data[4] & 7;
            const type: DeviceType = logicaltype === 1 ? 'Router' : logicaltype === 2 ? 'EndDevice' : logicaltype === 0 ? 'Coordinator' : 'Unknown';
            const manufacturer = buf.readUInt16LE(7);

            logger.debug(
                'RECEIVING NODE_DESCRIPTOR - addr: 0x' +
                    networkAddress.toString(16) +
                    ' type: ' +
                    type +
                    ' manufacturer: 0x' +
                    manufacturer.toString(16),
                NS,
            );
            return {manufacturerCode: manufacturer, type};
        } catch (error) {
            const msg = 'RECEIVING NODE_DESCRIPTOR FAILED - addr: 0x' + networkAddress.toString(16) + ' ' + error;
            logger.debug(msg, NS);
            return Promise.reject(new Error(msg));
        }
    }

    public async activeEndpoints(networkAddress: number): Promise<ActiveEndpoints> {
        const transactionID = this.nextTransactionID();
        const nwk1 = networkAddress & 0xff;
        const nwk2 = (networkAddress >> 8) & 0xff;
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID, nwk1, nwk2];

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x05; // active endpoints
        request.srcEndpoint = 0;
        request.asduLength = 3;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver
            .enqueueSendDataRequest(request)
            .then(() => {})
            .catch(() => {});

        try {
            const d = await this.waitForData(networkAddress, 0, 0x8005);
            const data = d.asduPayload;

            const buf = Buffer.from(data!);
            const epCount = buf.readUInt8(4);
            const epList = [];
            for (let i = 5; i < epCount + 5; i++) {
                epList.push(buf.readUInt8(i));
            }
            logger.debug('ACTIVE_ENDPOINTS - addr: 0x' + networkAddress.toString(16) + ' EP list: ' + epList, NS);
            return {endpoints: epList};
        } catch (error) {
            const msg = 'READING ACTIVE_ENDPOINTS FAILED - addr: 0x' + networkAddress.toString(16) + ' ' + error;
            logger.debug(msg, NS);
            return Promise.reject(new Error(msg));
        }
    }

    public async simpleDescriptor(networkAddress: number, endpointID: number): Promise<SimpleDescriptor> {
        const transactionID = this.nextTransactionID();
        const nwk1 = networkAddress & 0xff;
        const nwk2 = (networkAddress >> 8) & 0xff;
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID, nwk1, nwk2, endpointID];

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x04; // simple descriptor
        request.srcEndpoint = 0;
        request.asduLength = 4;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver
            .enqueueSendDataRequest(request)
            .then(() => {})
            .catch(() => {});

        try {
            const d = await this.waitForData(networkAddress, 0, 0x8004);
            const data = d.asduPayload!;

            const buf = Buffer.from(data);
            const inCount = buf.readUInt8(11);
            const inClusters = [];
            let cIndex = 12;
            for (let i = 0; i < inCount; i++) {
                inClusters[i] = buf.readUInt16LE(cIndex);
                cIndex += 2;
            }
            const outCount = buf.readUInt8(12 + inCount * 2);
            const outClusters = [];
            cIndex = 13 + inCount * 2;
            for (let l = 0; l < outCount; l++) {
                outClusters[l] = buf.readUInt16LE(cIndex);
                cIndex += 2;
            }

            const simpleDesc = {
                profileID: buf.readUInt16LE(6),
                endpointID: buf.readUInt8(5),
                deviceID: buf.readUInt16LE(8),
                inputClusters: inClusters,
                outputClusters: outClusters,
            };
            logger.debug(
                'RECEIVING SIMPLE_DESCRIPTOR - addr: 0x' +
                    networkAddress.toString(16) +
                    ' EP:' +
                    simpleDesc.endpointID +
                    ' inClusters: ' +
                    inClusters +
                    ' outClusters: ' +
                    outClusters,
                NS,
            );
            return simpleDesc;
        } catch (error) {
            const msg = 'RECEIVING SIMPLE_DESCRIPTOR FAILED - addr: 0x' + networkAddress.toString(16) + ' ' + error;
            logger.debug(msg, NS);
            return Promise.reject(new Error(msg));
        }
    }

    private async checkCoordinatorSimpleDescriptor(skip: boolean): Promise<void> {
        logger.debug('checking coordinator simple descriptor', NS);
        let simpleDesc: SimpleDescriptor | undefined;

        if (skip === false) {
            try {
                simpleDesc = await this.simpleDescriptor(0x0, 1);
            } catch {
                /* empty */
            }

            if (simpleDesc == undefined) {
                await this.checkCoordinatorSimpleDescriptor(false);
                return;
            }
            logger.debug('EP: ' + simpleDesc.endpointID, NS);
            logger.debug('profile ID: ' + simpleDesc.profileID, NS);
            logger.debug('device ID: ' + simpleDesc.deviceID, NS);
            for (let i = 0; i < simpleDesc.inputClusters.length; i++) {
                logger.debug('input cluster: 0x' + simpleDesc.inputClusters[i].toString(16), NS);
            }

            for (let o = 0; o < simpleDesc.outputClusters.length; o++) {
                logger.debug('output cluster: 0x' + simpleDesc.outputClusters[o].toString(16), NS);
            }

            let ok = true;
            if (simpleDesc.endpointID === 0x1) {
                if (
                    !simpleDesc.inputClusters.includes(0x0) ||
                    !simpleDesc.inputClusters.includes(0x0a) ||
                    !simpleDesc.inputClusters.includes(0x06) ||
                    !simpleDesc.inputClusters.includes(0x19) ||
                    !simpleDesc.inputClusters.includes(0x0501) ||
                    !simpleDesc.outputClusters.includes(0x01) ||
                    !simpleDesc.outputClusters.includes(0x20) ||
                    !simpleDesc.outputClusters.includes(0x500) ||
                    !simpleDesc.outputClusters.includes(0x502)
                ) {
                    logger.debug('missing cluster', NS);
                    ok = false;
                }

                if (ok === true) {
                    return;
                }
            }
        }

        logger.debug('setting new simple descriptor', NS);
        try {
            //[ sd1   ep    proId       devId       vers  #inCl iCl1        iCl2        iCl3        iCl4        iCl5        #outC oCl1        oCl2        oCl3        oCl4      ]
            const sd = [
                0x00, 0x01, 0x04, 0x01, 0x05, 0x00, 0x01, 0x05, 0x00, 0x00, 0x00, 0x06, 0x0a, 0x00, 0x19, 0x00, 0x01, 0x05, 0x04, 0x01, 0x00, 0x20,
                0x00, 0x00, 0x05, 0x02, 0x05,
            ];
            const sd1 = sd.reverse();
            await this.driver.writeParameterRequest(PARAM.PARAM.STK.Endpoint, sd1);
        } catch (error) {
            logger.debug(`error setting simple descriptor: ${error} - try again`, NS);
            await this.checkCoordinatorSimpleDescriptor(true);
            return;
        }
        logger.debug('success setting simple descriptor', NS);
    }

    public waitFor(
        networkAddress: number | undefined,
        endpoint: number,
        frameType: Zcl.FrameType,
        direction: Zcl.Direction,
        transactionSequenceNumber: number | undefined,
        clusterID: number,
        commandIdentifier: number,
        timeout: number,
    ): {promise: Promise<Events.ZclPayload>; cancel: () => void} {
        const payload = {
            address: networkAddress,
            endpoint,
            clusterID,
            commandIdentifier,
            frameType,
            direction,
            transactionSequenceNumber,
        };
        const waiter = this.waitress.waitFor(payload, timeout);
        const cancel = (): void => this.waitress.remove(waiter.ID);
        return {promise: waiter.start().promise, cancel};
    }

    public async sendZclFrameToEndpoint(
        ieeeAddr: string,
        networkAddress: number,
        endpoint: number,
        zclFrame: Zcl.Frame,
        timeout: number,
        disableResponse: boolean,
        disableRecovery: boolean,
        sourceEndpoint?: number,
    ): Promise<Events.ZclPayload | void> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};

        const pay = zclFrame.toBuffer();
        //logger.info("zclFramte.toBuffer:", NS);
        //logger.info(pay, NS);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = endpoint;
        request.profileId = sourceEndpoint === 242 && endpoint === 242 ? 0xa1e0 : 0x104;
        request.clusterId = zclFrame.cluster.ID;
        request.srcEndpoint = sourceEndpoint || 1;
        request.asduLength = pay.length;
        request.asduPayload = [...pay];
        request.txOptions = this.TX_OPTIONS; // 0x00 normal; 0x04 APS ACK
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = timeout;

        const command = zclFrame.command;

        this.driver
            .enqueueSendDataRequest(request)
            .then(() => {
                logger.debug(`sendZclFrameToEndpoint - message send with transSeq Nr.: ${zclFrame.header.transactionSequenceNumber}`, NS);
                logger.debug(
                    (command.response !== undefined) +
                        ', ' +
                        zclFrame.header.frameControl.disableDefaultResponse +
                        ', ' +
                        disableResponse +
                        ', ' +
                        request.timeout,
                    NS,
                );

                if (command.response == undefined || zclFrame.header.frameControl.disableDefaultResponse || !disableResponse) {
                    logger.debug(`resolve request (${zclFrame.header.transactionSequenceNumber})`, NS);
                    return Promise.resolve();
                }
            })
            .catch((error) => {
                logger.debug(`sendZclFrameToEndpoint ERROR (${zclFrame.header.transactionSequenceNumber})`, NS);
                logger.debug(error, NS);
                //return Promise.reject(new Error("sendZclFrameToEndpoint ERROR " + error));
            });

        try {
            let data = null;
            if ((command.response != undefined && !disableResponse) || !zclFrame.header.frameControl.disableDefaultResponse) {
                data = await this.waitForData(networkAddress, 0x104, zclFrame.cluster.ID, zclFrame.header.transactionSequenceNumber, request.timeout);
            }

            if (data !== null) {
                const asdu = data.asduPayload!;
                const buffer = Buffer.from(asdu);

                const response: Events.ZclPayload = {
                    address: data.srcAddr16 ?? `0x${data.srcAddr64!}`,
                    data: buffer,
                    clusterID: zclFrame.cluster.ID,
                    header: Zcl.Header.fromBuffer(buffer),
                    endpoint: data.srcEndpoint!,
                    linkquality: data.lqi!,
                    groupID: data.srcAddrMode === 0x01 ? data.srcAddr16! : 0,
                    wasBroadcast: data.srcAddrMode === 0x01 || data.srcAddrMode === 0xf,
                    destinationEndpoint: data.destEndpoint!,
                };
                logger.debug(`response received (${zclFrame.header.transactionSequenceNumber})`, NS);
                return response;
            } else {
                logger.debug(`no response expected (${zclFrame.header.transactionSequenceNumber})`, NS);
            }
        } catch (error) {
            throw new Error(`no response received (${zclFrame.header.transactionSequenceNumber}) ${error}`);
        }
    }

    public async sendZclFrameToGroup(groupID: number, zclFrame: Zcl.Frame): Promise<void> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};
        const pay = zclFrame.toBuffer();

        logger.debug('zclFrame to group - zclFrame.payload:', NS);
        logger.debug(zclFrame.payload, NS);
        //logger.info("zclFramte.toBuffer:", NS);
        //logger.info(pay, NS);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.GROUP_ADDR;
        request.destAddr16 = groupID;
        request.profileId = 0x104;
        request.clusterId = zclFrame.cluster.ID;
        request.srcEndpoint = 1;
        request.asduLength = pay.length;
        request.asduPayload = [...pay];
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.UNLIMITED;

        logger.debug(`sendZclFrameToGroup - message send`, NS);
        return this.driver.enqueueSendDataRequest(request) as Promise<void>;
    }

    public async sendZclFrameToAll(endpoint: number, zclFrame: Zcl.Frame, sourceEndpoint: number, destination: BroadcastAddress): Promise<void> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};
        const pay = zclFrame.toBuffer();

        logger.debug('zclFrame to all - zclFrame.payload:', NS);
        logger.debug(zclFrame.payload, NS);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = destination;
        request.destEndpoint = endpoint;
        request.profileId = sourceEndpoint === 242 && endpoint === 242 ? 0xa1e0 : 0x104;
        request.clusterId = zclFrame.cluster.ID;
        request.srcEndpoint = sourceEndpoint;
        request.asduLength = pay.length;
        request.asduPayload = [...pay];
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.UNLIMITED;

        logger.debug(`sendZclFrameToAll - message send`, NS);
        return this.driver.enqueueSendDataRequest(request) as Promise<void>;
    }

    public async bind(
        destinationNetworkAddress: number,
        sourceIeeeAddress: string,
        sourceEndpoint: number,
        clusterID: number,
        destinationAddressOrGroup: string | number,
        type: 'endpoint' | 'group',
        destinationEndpoint?: number,
    ): Promise<void> {
        const transactionID = this.nextTransactionID();
        const clid1 = clusterID & 0xff;
        const clid2 = (clusterID >> 8) & 0xff;
        const destAddrMode = type === 'group' ? PARAM.PARAM.addressMode.GROUP_ADDR : PARAM.PARAM.addressMode.IEEE_ADDR;
        let destArray: number[];

        if (type === 'endpoint') {
            assert(destinationEndpoint, 'Destination endpoint must be defined when `type === endpoint`');
            destArray = this.driver.macAddrStringToArray(destinationAddressOrGroup as string);
            destArray = destArray.concat([destinationEndpoint]);
        } else {
            destArray = [destinationAddressOrGroup as number & 0xff, ((destinationAddressOrGroup as number) >> 8) & 0xff];
        }
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID]
            .concat(this.driver.macAddrStringToArray(sourceIeeeAddress))
            .concat([sourceEndpoint, clid1, clid2, destAddrMode])
            .concat(destArray);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = destinationNetworkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x21; // bind_request
        request.srcEndpoint = 0;
        request.asduLength = zdpFrame.length;
        request.asduPayload = zdpFrame;
        request.txOptions = 0x04; // 0x04 use APS ACKS
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver
            .enqueueSendDataRequest(request)
            .then(() => {})
            .catch(() => {});

        try {
            const d = await this.waitForData(destinationNetworkAddress, 0, 0x8021);
            const data = d.asduPayload!;
            logger.debug('BIND RESPONSE - addr: 0x' + destinationNetworkAddress.toString(16) + ' status: ' + data[1], NS);
            if (data[1] !== 0) {
                throw new Error('status: ' + data[1]);
            }
        } catch (error) {
            logger.debug('BIND FAILED - addr: 0x' + destinationNetworkAddress.toString(16) + ' ' + error, NS);
            throw error;
        }
    }

    public async unbind(
        destinationNetworkAddress: number,
        sourceIeeeAddress: string,
        sourceEndpoint: number,
        clusterID: number,
        destinationAddressOrGroup: string | number,
        type: 'endpoint' | 'group',
        destinationEndpoint?: number,
    ): Promise<void> {
        const transactionID = this.nextTransactionID();
        const clid1 = clusterID & 0xff;
        const clid2 = (clusterID >> 8) & 0xff;
        const destAddrMode = type === 'group' ? PARAM.PARAM.addressMode.GROUP_ADDR : PARAM.PARAM.addressMode.IEEE_ADDR;
        let destArray: number[];

        if (type === 'endpoint') {
            assert(destinationEndpoint, 'Destination endpoint must be defined when `type === endpoint`');
            destArray = this.driver.macAddrStringToArray(destinationAddressOrGroup as string);
            destArray = destArray.concat([destinationEndpoint]);
        } else {
            destArray = [destinationAddressOrGroup as number & 0xff, ((destinationAddressOrGroup as number) >> 8) & 0xff];
        }

        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID]
            .concat(this.driver.macAddrStringToArray(sourceIeeeAddress))
            .concat([sourceEndpoint, clid1, clid2, destAddrMode])
            .concat(destArray);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = destinationNetworkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x22; // unbind_request
        request.srcEndpoint = 0;
        request.asduLength = zdpFrame.length;
        request.asduPayload = zdpFrame;
        request.txOptions = 0x04; // 0x04 use APS ACKS
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver
            .enqueueSendDataRequest(request)
            .then(() => {})
            .catch(() => {});

        try {
            const d = await this.waitForData(destinationNetworkAddress, 0, 0x8022);
            const data = d.asduPayload!;
            logger.debug('UNBIND RESPONSE - addr: 0x' + destinationNetworkAddress.toString(16) + ' status: ' + data[1], NS);
            if (data[1] !== 0) {
                throw new Error('status: ' + data[1]);
            }
        } catch (error) {
            logger.debug('UNBIND FAILED - addr: 0x' + destinationNetworkAddress.toString(16) + ' ' + error, NS);
            throw error;
        }
    }

    public async removeDevice(networkAddress: number, ieeeAddr: string): Promise<void> {
        const transactionID = this.nextTransactionID();
        // const nwk1 = networkAddress & 0xff;
        // const nwk2 = (networkAddress >> 8) & 0xff;
        const request: ApsDataRequest = {};
        //const zdpFrame = [transactionID].concat(this.driver.macAddrStringToArray(ieeeAddr)).concat([0]);
        const zdpFrame = [transactionID].concat([0, 0, 0, 0, 0, 0, 0, 0]).concat([0]);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x34; // mgmt_leave_request
        request.srcEndpoint = 0;
        request.asduLength = 10;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;

        this.driver
            .enqueueSendDataRequest(request)
            .then(() => {})
            .catch(() => {});

        try {
            const d = await this.waitForData(networkAddress, 0, 0x8034);
            const data = d.asduPayload!;
            logger.debug('REMOVE_DEVICE - addr: 0x' + networkAddress.toString(16) + ' status: ' + data[1], NS);
            const payload: Events.DeviceLeavePayload = {
                networkAddress: networkAddress,
                ieeeAddr: ieeeAddr,
            };
            if (data[1] !== 0) {
                throw new Error('status: ' + data[1]);
            }
            this.emit('deviceLeave', payload);
        } catch (error) {
            logger.debug('REMOVE_DEVICE FAILED - addr: 0x' + networkAddress.toString(16) + ' ' + error, NS);
            throw error;
        }
    }

    public async supportsBackup(): Promise<boolean> {
        return false;
    }

    public async backup(): Promise<Models.Backup> {
        throw new Error('This adapter does not support backup');
    }

    public async getNetworkParameters(): Promise<NetworkParameters> {
        try {
            const panid = await this.driver.readParameterRequest(PARAM.PARAM.Network.PAN_ID);
            const expanid = await this.driver.readParameterRequest(PARAM.PARAM.Network.APS_EXT_PAN_ID);
            const channel = await this.driver.readParameterRequest(PARAM.PARAM.Network.CHANNEL);
            return {
                panID: panid as number,
                extendedPanID: expanid as number,
                channel: channel as number,
            };
        } catch (error) {
            const msg = 'get network parameters Error:' + error;
            logger.debug(msg, NS);
            return Promise.reject(new Error(msg));
        }
    }

    public async restoreChannelInterPAN(): Promise<void> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async sendZclFrameInterPANToIeeeAddr(zclFrame: Zcl.Frame, ieeeAddr: string): Promise<void> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async sendZclFrameInterPANBroadcast(zclFrame: Zcl.Frame, timeout: number): Promise<Events.ZclPayload> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async sendZclFrameInterPANBroadcastWithResponse(zclFrame: Zcl.Frame, timeout: number): Promise<Events.ZclPayload> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async setChannelInterPAN(channel: number): Promise<void> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async changeChannel(newChannel: number): Promise<void> {
        throw new Error(`Channel change is not supported for 'deconz'`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async setTransmitPower(value: number): Promise<void> {
        throw new Error('not supported');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async sendZclFrameInterPANIeeeAddr(zclFrame: Zcl.Frame, ieeeAddr: string): Promise<void> {
        throw new Error('not supported');
    }

    /**
     * Private methods
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private waitForData(
        addr: number,
        profileId: number,
        clusterId: number,
        transactionSequenceNumber?: number,
        timeout?: number,
    ): Promise<ReceivedDataResponse> {
        return new Promise((resolve, reject): void => {
            const ts = Date.now();
            // const commandId = PARAM.PARAM.APS.DATA_INDICATION;
            const req: WaitForDataRequest = {addr, profileId, clusterId, transactionSequenceNumber, resolve, reject, ts, timeout};
            this.openRequestsQueue.push(req);
        });
    }

    private checkReceivedGreenPowerIndication(ind: gpDataInd): void {
        const gpdHeader = Buffer.alloc(15); // applicationId === IEEE_ADDRESS ? 20 : 15
        gpdHeader.writeUInt8(0b00000001, 0); // frameControl: FrameType.SPECIFIC + Direction.CLIENT_TO_SERVER + disableDefaultResponse=false
        gpdHeader.writeUInt8(ind.seqNr!, 1);
        gpdHeader.writeUInt8(ind.id!, 2); // commandIdentifier
        gpdHeader.writeUInt16LE(0, 3); // options, only srcID present
        gpdHeader.writeUInt32LE(ind.srcId!, 5);
        // omitted: gpdIEEEAddr (ieeeAddr)
        // omitted: gpdEndpoint (uint8)
        gpdHeader.writeUInt32LE(ind.frameCounter!, 9);
        gpdHeader.writeUInt8(ind.commandId!, 13);
        gpdHeader.writeUInt8(ind.commandFrameSize!, 14);

        const payBuf = Buffer.concat([gpdHeader, ind.commandFrame!]);
        const payload: Events.ZclPayload = {
            header: Zcl.Header.fromBuffer(payBuf),
            data: payBuf,
            clusterID: Zcl.Clusters.greenPower.ID,
            address: ind.srcId! & 0xffff,
            endpoint: ZSpec.GP_ENDPOINT,
            linkquality: 0xff, // bogus
            groupID: ZSpec.GP_GROUP_ID,
            wasBroadcast: true, // Take the codepath that doesn't require `gppNwkAddr` as its not present in the payload
            destinationEndpoint: ZSpec.GP_ENDPOINT,
        };

        this.waitress.resolve(payload);
        this.emit('zclPayload', payload);
    }

    private checkReceivedDataPayload(resp: ReceivedDataResponse | null): void {
        let srcAddr: number | undefined = undefined;
        let header: Zcl.Header | undefined;
        const payBuf = resp != null ? Buffer.from(resp.asduPayload!) : undefined;

        if (resp != null) {
            if (resp.srcAddr16 != null) {
                srcAddr = resp.srcAddr16;
            } else {
                // For some devices srcAddr64 is reported by ConBee 3, even if the frame contains both
                // srcAddr16 and srcAddr64. This happens even if the request was sent to a short address.
                // At least some parts, e.g. the while loop below, only work with srcAddr16 (i.e. the network
                // address) being set. So we try to look up the network address in the list of know devices.
                if (resp.srcAddr64 != null) {
                    logger.debug(`Try to find network address of ${resp.srcAddr64}`, NS);
                    // Note: Device expects addresses with a 0x prefix...
                    srcAddr = Device.byIeeeAddr('0x' + resp.srcAddr64, false)?.networkAddress;
                }

                assert(srcAddr, 'Failed to find srcAddr of message');
                // apperantly some functions furhter up in the protocol stack expect this to be set.
                // so let's make sure they get the network address
                resp.srcAddr16 = srcAddr; // TODO: can't be undefined
            }
            if (resp.profileId != 0x00) {
                header = Zcl.Header.fromBuffer(payBuf!); // valid from check
            }
        }

        let i = this.openRequestsQueue.length;

        while (i--) {
            const req: WaitForDataRequest = this.openRequestsQueue[i];

            if (srcAddr != null && req.addr === srcAddr && req.clusterId === resp?.clusterId && req.profileId === resp?.profileId) {
                if (header !== undefined && req.transactionSequenceNumber != undefined) {
                    if (req.transactionSequenceNumber === header.transactionSequenceNumber) {
                        logger.debug('resolve data request with transSeq Nr.: ' + req.transactionSequenceNumber, NS);
                        this.openRequestsQueue.splice(i, 1);
                        req.resolve?.(resp);
                    }
                } else {
                    logger.debug('resolve data request without a transSeq Nr.', NS);
                    this.openRequestsQueue.splice(i, 1);
                    req.resolve?.(resp);
                }
            }

            const now = Date.now();

            // Default timeout: 60 seconds.
            // Comparison is negated to prevent orphans when invalid timeout is entered (resulting in NaN).
            if (!(now - req.ts! <= (req.timeout ?? 60000))) {
                //logger.debug("Timeout for request in openRequestsQueue addr: " + req.addr.toString(16) + " clusterId: " + req.clusterId.toString(16) + " profileId: " + req.profileId.toString(16), NS);
                //remove from busyQueue
                this.openRequestsQueue.splice(i, 1);
                req.reject?.('waiting for response TIMEOUT');
            }
        }

        // check unattended incomming messages
        if (resp != null && resp.profileId === 0x00 && resp.clusterId === 0x13) {
            // device Annce
            const payload: Events.DeviceJoinedPayload = {
                networkAddress: payBuf!.readUInt16LE(1), // valid from check
                ieeeAddr: this.driver.macAddrArrayToString(resp.asduPayload!.slice(3, 11)),
            };
            if (this.joinPermitted === true) {
                this.emit('deviceJoined', payload);
            } else {
                this.emit('deviceAnnounce', payload);
            }
        }

        if (resp != null && resp.profileId != 0x00) {
            const payload: Events.ZclPayload = {
                clusterID: resp.clusterId!,
                header,
                data: payBuf!, // valid from check
                address: resp.destAddrMode === 0x03 ? `0x${resp.srcAddr64!}` : resp.srcAddr16!,
                endpoint: resp.srcEndpoint!,
                linkquality: resp.lqi!,
                groupID: resp.destAddrMode === 0x01 ? resp.destAddr16! : 0,
                wasBroadcast: resp.destAddrMode === 0x01 || resp.destAddrMode === 0xf,
                destinationEndpoint: resp.destEndpoint!,
            };

            this.waitress.resolve(payload);
            this.emit('zclPayload', payload);
        }
    }

    private nextTransactionID(): number {
        this.transactionID++;

        if (this.transactionID > 255) {
            this.transactionID = 1;
        }

        return this.transactionID;
    }

    private waitressTimeoutFormatter(matcher: WaitressMatcher, timeout: number): string {
        return (
            `Timeout - ${matcher.address} - ${matcher.endpoint}` +
            ` - ${matcher.transactionSequenceNumber} - ${matcher.clusterID}` +
            ` - ${matcher.commandIdentifier} after ${timeout}ms`
        );
    }

    private waitressValidator(payload: Events.ZclPayload, matcher: WaitressMatcher): boolean {
        return Boolean(
            payload.header &&
                (!matcher.address || payload.address === matcher.address) &&
                payload.endpoint === matcher.endpoint &&
                (!matcher.transactionSequenceNumber || payload.header.transactionSequenceNumber === matcher.transactionSequenceNumber) &&
                payload.clusterID === matcher.clusterID &&
                matcher.frameType === payload.header.frameControl.frameType &&
                matcher.commandIdentifier === payload.header.commandIdentifier &&
                matcher.direction === payload.header.frameControl.direction,
        );
    }
}

export default DeconzAdapter;
