'use strict';

const path = require('path');
const { logger, _, fs, assert, loadFile } = require('@micro-app/shared-utils');

const BaseService = require('./BaseService');
const { parsePackageInfo } = require('./PackageInfo');
const ExtraConfig = require('../../ExtraConfig');

const Package = require('../../Package');
const PackageGraph = require('../../PackageGraph');
const CONSTANTS = require('../../Constants');
const makeFileFinder = require('../../../utils/makeFileFinder');

const requireMicro = require('../../../utils/requireMicro');
const loadConfigFile = require('../../../utils/loadConfigFile');

// 全局状态集
const GLOBAL_STATE = {};

class MethodService extends BaseService {

    constructor(context) {
        super(context);

        this.commands = {};

        this.state = GLOBAL_STATE; // 状态集
    }

    get tempDirName() {
        return CONSTANTS.MICRO_APP_TEMP_DIR;
    }

    get tempDir() {
        return path.resolve(this.root, this.tempDirName);
    }

    get tempDirNodeModules() {
        const tempDirName = this.tempDirName;
        return path.join(tempDirName, CONSTANTS.NODE_MODULES_NAME);
    }

    get tempDirPackageGraph() {
        const pkgInfos = this.fileFinder(CONSTANTS.PACKAGE_JSON, filePaths => {
            return filePaths.map(filePath => {
                const packageJson = loadFile(filePath);
                return new Package(packageJson, path.dirname(filePath), this.root);
            });
        });
        logger.debug('[fileFinder]', `packages length: '${pkgInfos.length}'`);
        const tempDirPackageGraph = new PackageGraph(pkgInfos, 'dependencies');
        return tempDirPackageGraph;
    }

    // micros 配置
    get packages() {
        const packages = (this.self.packages || []).map(item => {
            const name = item.name;
            const spec = item.spec || false;
            // ZAP 处理解析
            return parsePackageInfo(name, this.root, spec);
        }).filter(pkg => !!pkg);

        Object.defineProperty(this, 'packages', {
            value: packages,
        });

        return packages;
    }

    get micros() {
        const selfMicros = this.self.micros || [];
        const microsSet = new Set(selfMicros);
        // 当前可用服务
        const micros = [ ...microsSet ];
        // redefine getter to lazy-loaded value
        Object.defineProperty(this, 'micros', {
            writable: true,
            value: micros,
        });
        return micros;
    }

    get microsConfig() {
        const config = {};
        const microsExtraConfig = this.microsExtraConfig || {};

        // 暂时已被优化
        // const scope = this.tempDirNodeModules;
        this.micros.forEach(key => {
            const microConfig = requireMicro(key, id => {
                // @custom 开发模式软链接
                const extralConfig = microsExtraConfig[id];
                if (extralConfig && extralConfig.link && fs.existsSync(extralConfig.link)) {
                    return extralConfig.link;
                }
                return null;
            });
            // if (!microConfig) { // 私有的
            //     logger.debug('[Micros]', 'try load private package micros!');
            //     microConfig = requireMicro(key, scope);
            // }
            if (microConfig) {
                config[key] = _.cloneDeep(microConfig);
            }
            if (!config[key]) {
                logger.warn('[Micros]', `Not Found micros: "${key}"`);
            }
        });

        const microsSet = new Set(Object.keys(config));
        // refresh enable micros, freeze
        Object.defineProperty(this, 'micros', {
            value: [ ...microsSet ],
        });

        const selfKey = this.selfKey;
        config[selfKey] = _.cloneDeep(this.self);

        Object.defineProperty(this, 'microsConfig', {
            writable: true,
            value: config,
        });

        // redirect
        Object.defineProperty(this, 'selfConfig', {
            get() {
                return this.microsConfig[selfKey] || {};
            },
        });

        return config;
    }

    // 扩增配置
    get extraConfig() {
        // 加载高级附加配置
        const extraConfig = new ExtraConfig(this.root, this.context);

        Object.defineProperty(this, 'extraConfig', {
            value: extraConfig,
        });

        return extraConfig || {};
    }

    // 扩增配置中的 micros
    get microsExtraConfig() {
        const extraConfig = this.extraConfig || {};
        return extraConfig.micros || {};
    }

    get microsPackages() {
        return Object.values(this.microsConfig).map(config => config.manifest);
    }

    get microsPackageGraph() {
        const microsPackageGraph = new PackageGraph(this.microsPackages);

        Object.defineProperty(this, 'microsPackageGraph', {
            writable: true,
            value: microsPackageGraph,
        });

        return microsPackageGraph;
    }

    get fileFinder() {
        const finder = makeFileFinder(this.root, [ `${this.tempDirNodeModules}/*`, `${this.tempDirNodeModules}/*/*` ]);

        // redefine getter to lazy-loaded value
        Object.defineProperty(this, 'fileFinder', {
            value: finder,
        });

        return finder;
    }

    setState(key, value) {
        this.state[key] = value;
    }

    getState(key, value) {
        return this.state[key] || value;
    }

    resolve(_path) {
        return path.resolve(this.root, _path);
    }

    assertExtendOptions(name, opts, fn) {
        assert(typeof name === 'string', 'name must be string.');
        assert(name || /^_/i.test(name), `${name} cannot begin with '_'.`);
        assert(!this[name] || !this.extendConfigs[name] || !this.extendMethods[name] || !this.pluginMethods[name] || !this.sharedProps[name], `api.${name} exists.`);
        if (typeof opts === 'function') {
            fn = opts;
            opts = null;
        }
        assert(typeof fn === 'function', 'fn must be function.');
        opts = opts || {};
        assert(_.isPlainObject(opts), 'opts must be object.');
        return { name, opts, fn };
    }

    extendConfig(name, opts, fn) {
        const extendObj = this.assertExtendOptions(name, opts, fn);
        this.extendConfigs[extendObj.name] = {
            ...extendObj.opts,
            fn: extendObj.fn,
        };
        logger.debug('[Plugin]', `extendConfig( ${extendObj.name} ); Success!`);
    }

    extendMethod(name, opts, fn) {
        const extendObj = this.assertExtendOptions(name, opts, fn);
        this.extendMethods[extendObj.name] = {
            ...extendObj.opts,
            fn: extendObj.fn,
        };
        logger.debug('[Plugin]', `extendMethod( ${extendObj.name} ); Success!`);
    }

    registerCommand(name, opts, fn) {
        assert(!this.commands[name], `Command ${name} exists, please select another one.`);
        if (typeof opts === 'function') {
            fn = opts;
            opts = null;
        }
        opts = opts || {};
        this.commands[name] = { fn, opts };
        logger.debug('[Plugin]', `registerCommand( ${name} ); Success!`);
    }

    /**
     * 解析指定key的其它name的配置信息
     *
     * @param {string} name config name
     * @param {string} key micro key
     * @return {Object} config
     * @memberof BaseService
     */
    parseConfig(name, key = this.selfKey) {
        assert(typeof name === 'string', 'name must be string.');
        assert(typeof key === 'string', 'key must be string.');
        const microsConfig = this.microsConfig;
        const microConfig = microsConfig[key];
        if (microConfig && microConfig.__isMicroAppConfig) {
            const root = microConfig.root;
            const filename = CONSTANTS.EXTRAL_CONFIG_NAME.replace(/extra/, name);
            const _config = loadConfigFile(root, filename);
            if (!_.isEmpty(_config)) {
                return _config;
            }
            // 文件夹中
            const subFileName = `${name}.config`;
            const tempDirRoot = path.resolve(root, this.tempDirName);
            const _microsConfig = loadConfigFile(tempDirRoot, subFileName);
            if (!_.isEmpty(_microsConfig)) {
                return _microsConfig;
            }
            // 附加配置中
            const _extraConfig = this.extraConfig || {};
            if (!_.isEmpty(_extraConfig[name])) {
                return _extraConfig[name];
            }
            // 以下可能会冲突，不考虑
            // const _originalConfig = microConfig.originalConfig || {};
            // if (!_.isEmpty(_originalConfig[name])) {
            //     return _originalConfig[name];
            // }
        }
        return null;
    }
}

module.exports = MethodService;
