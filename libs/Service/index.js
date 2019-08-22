'use strict';

const tryRequire = require('try-require');
const assert = require('assert');
const merge = require('webpack-merge');
const _ = require('lodash');

const requireMicro = require('../../utils/requireMicro');
const logger = require('../../utils/logger');

const serverMerge = require('../../utils/merge-server');
const serverHooksMerge = require('../../utils/merge-server-hooks');

const PluginAPI = require('./PluginAPI');

const { PreLoadPlugins, SharedProps } = require('./Contants');

// 全局状态集
const GLOBAL_STATE = {};

class Service {
    constructor() {
        // 当前服务
        this.pluginHooks = {};
        this.pluginMethods = {};
        this.commands = {};

        this.selfConfig = this.self.toConfig(true);
        this.selfServerConfig = this.self.toServerConfig();
        this.micros = new Set((this.self.micros || []));
        this.microsConfig = this.initMicrosConfig();
        this.microsServerConfig = this.initMicrosServerConfig();

        this.config = {};
        this.serverConfig = {};
        this.state = GLOBAL_STATE; // 状态集

        this.plugins = PreLoadPlugins.map(this.resolvePlugin);
    }

    get self() {
        const _self = requireMicro.self();
        assert(_self, logger.toString.error('not found "micro-app.config.js"'));
        return _self;
    }

    initMicrosConfig() {
        const config = {};
        const micros = _.cloneDeep([ ...this.micros ]);
        micros.forEach(key => {
            const microConfig = requireMicro(key);
            if (microConfig) {
                config[key] = microConfig.toConfig(true);
            } else {
                this.micros.delete(key);
                logger.error(`not found micros: "${key}"`);
            }
        });
        config[this.self.key] = this.selfConfig || this.self.toConfig(true);
        return config;
    }

    initMicrosServerConfig() {
        const config = {};
        const micros = _.cloneDeep([ ...this.micros ]);
        micros.forEach(key => {
            const microConfig = requireMicro(key);
            if (microConfig) {
                config[key] = microConfig.toServerConfig();
            } else {
                this.micros.delete(key);
                logger.error(`not found micros: "${key}"`);
            }
        });
        config[this.self.key] = this.selfServerConfig || this.self.toServerConfig();
        return config;
    }

    initDotEnv() {
        const dotenv = tryRequire('dotenv');
        if (dotenv) {
            const result = dotenv.config();
            if (result.error) {
                throw logger.toString.error(result.error);
            } else if (result.parsed) {
                const config = result.parsed;
                if (config.HOSTNAME) { // fixed
                    process.env.HOSTNAME = config.HOSTNAME;
                }
                logger.info('dotenv parsed envs:\n', JSON.stringify(result.parsed, null, 4));
            }
        } else {
            logger.warn('not found "dotenv"');
        }
    }

    registerPlugin(opts) {
        assert(_.isPlainObject(opts), `opts should be plain object, but got ${opts}`);
        const { id, apply } = opts;
        assert(id && apply, 'id and apply must supplied');
        assert(typeof id === 'string', 'id must be string');
        assert(typeof apply === 'function', 'apply must be function');
        assert(
            id.indexOf('built-in:') !== 0,
            'service.registerPlugin() should not register plugin prefixed with "built-in:"'
        );
        assert(
            Object.keys(opts).every(key => [ 'id', 'apply', 'opts' ].includes(key)),
            'Only id, apply and opts is valid plugin properties'
        );
        this.plugins.push(opts);
    }

    resolvePlugin(item) {
        const { id, link, opts = {} } = item;
        const apply = tryRequire(link);
        if (apply) {
            return {
                ...item,
                apply: apply.default || apply,
                opts,
            };
        }
        logger.warn(`not found plugin: "${id}"`);
        return false;
    }

    applyPluginHooks(key, opts = {}) {
        const defaultOpts = _.cloneDeep(opts);
        return (this.pluginHooks[key] || []).reduce((last, { fn }) => {
            try {
                return fn({
                    last,
                    args: defaultOpts,
                });
            } catch (e) {
                logger.error(`Plugin apply failed: ${e.message}`);
                throw e;
            }
        }, opts);
    }

    async applyPluginHooksAsync(key, opts = {}) {
        const defaultOpts = _.cloneDeep(opts);
        const hooks = this.pluginHooks[key] || [];
        let last = opts;
        for (const hook of hooks) {
            const { fn } = hook;
            // eslint-disable-next-line no-await-in-loop
            last = await fn({
                last,
                args: defaultOpts,
            });
        }
        return last;
    }

    getPlugins() {
        const micros = _.cloneDeep([ ...this.micros ]);
        const plugins = this.selfConfig.plugins || [];
        const allplugins = micros.map(key => {
            return this.microsConfig[key].plugins || [];
        }).concat(plugins);
        const pluginsObj = allplugins.map(item => {
            return this.resolvePlugin(item);
        }).filter(item => !!item);
        return pluginsObj;
    }

    initPlugins() {
        this.plugins.push(...this.getPlugins());

        this.plugins.forEach(plugin => {
            this.initPlugin(plugin);
        });

        // Throw error for methods that can't be called after plugins is initialized
        this.plugins.forEach(plugin => {
            Object.keys(plugin._api).forEach(method => {
                if (/^register/i.test(method) || [
                    'onOptionChange',
                ].includes(method)) {
                    plugin._api[method] = () => {
                        throw logger.toString.error(`api.${method}() should not be called after plugin is initialized.`);
                    };
                }
            });
        });
    }

    initPlugin(plugin) {
        const { id, apply, opts } = plugin;
        assert(typeof apply === 'function',
            logger.toString.error(`
            plugin must export a function, e.g.
              export default function(api) {
                // Implement functions via api
              }`.trim())
        );
        const _api = new PluginAPI(id, this);
        const api = new Proxy(_api, {
            get: (target, prop) => {
                if (typeof prop === 'string' && /^_/i.test(prop)) {
                    return; // ban private
                }
                if (this.pluginMethods[prop]) {
                    return this.pluginMethods[prop].fn;
                }
                if (SharedProps.includes(prop)) {
                    if (typeof this[prop] === 'function') {
                        return this[prop].bind(this);
                    }
                    if (prop === 'micros') {
                        return [ ...this[prop] ];
                    }
                    return this[prop] && Object.freeze(this[prop]);
                }
                if (prop === 'service') {
                    return target[prop] && Object.freeze(target[prop]);
                }
                return target[prop];
            },
        });
        api.onOptionChange = fn => {
            logger.info('onOptionChange...');
            assert(
                typeof fn === 'function',
                `The first argument for api.onOptionChange should be function in ${id}.`
            );
            plugin._onOptionChange = fn;
        };

        apply(api, opts);
        plugin._api = api;
    }

    changePluginOption(id, newOpts = {}) {
        assert(id, 'id must supplied');
        const plugins = this.plugins.filter(p => p.id === id);
        assert(plugins.length > 0, `plugin ${id} not found`);
        plugins.forEach(plugin => {
            const oldOpts = plugin.opts;
            plugin.opts = newOpts;
            if (plugin._onOptionChange) {
                plugin._onOptionChange(newOpts, oldOpts);
            } else {
                logger.warn(`plugin ${id}'s option changed, \n      nV: ${JSON.stringify(newOpts)}, \n      oV: ${JSON.stringify(oldOpts)}`);
            }
        });
    }

    registerCommand(name, opts, fn) {
        assert(!this.commands[name], `Command ${name} exists, please select another one.`);
        if (typeof opts === 'function') {
            fn = opts;
            opts = null;
        }
        opts = opts || {};
        this.commands[name] = { fn, opts };
    }

    mergeConfig() {
        const selfConfig = this.selfConfig;
        const micros = _.cloneDeep([ ...this.micros ]);
        const microsConfig = this.microsConfig;
        const finalConfig = merge.smart({}, micros.map(key => {
            if (!microsConfig[key]) return {};
            return _.pick(microsConfig[key], [
                'entry',
                'htmls',
                'dlls',
                'alias',
                'resolveAlias',
                'shared',
                'resolveShared',
                'staticPaths',
            ]);
        }), selfConfig);
        Object.assign(this.config, _.cloneDeep(finalConfig));
    }

    mergeServerConfig() {
        const selfServerConfig = this.selfServerConfig;
        const microsServerConfig = this.microsServerConfig;
        const serverEntrys = serverMerge(...Object.values(microsServerConfig), selfServerConfig);
        const serverHooks = serverHooksMerge(...Object.values(microsServerConfig), selfServerConfig);
        Object.assign(this.serverConfig, {
            ..._.pick(selfServerConfig, [
                'host',
                'port',
            ]),
            contentBase: selfServerConfig.contentBase || selfServerConfig.staticBase,
            entrys: serverEntrys,
            hooks: serverHooks,
        });
    }

    init() {
        this.initDotEnv();
        this.initPlugins();
        this.applyPluginHooks('onPluginInitDone');
        // merge config
        this.applyPluginHooks('beforeMergeConfig', this.config);
        this.mergeConfig();
        this.applyPluginHooks('afterMergeConfig', this.config);
        // merge server
        this.applyPluginHooks('beforeMergeServerConfig', this.serverConfig);
        this.mergeServerConfig();
        this.applyPluginHooks('afterMergeServerConfig', this.serverConfig);

        this.applyPluginHooks('onInitWillDone');
        this.applyPluginHooks('onInitDone');
    }

    run(name = 'help', args) {
        this.init();
        return this.runCommand(name, args);
    }

    runCommand(rawName, rawArgs) {
        logger.debug(`raw command name: ${rawName}, args: `, rawArgs);
        const { name = rawName, args } = this.applyPluginHooks('modifyCommand', {
            name: rawName,
            args: rawArgs,
        });
        logger.debug(`run ${name} with args: `, args);

        const command = this.commands[name];
        if (!command) {
            logger.error(`Command "${name}" does not exists`);
            process.exit(1);
        }

        const { fn, opts } = command;
        this.applyPluginHooks('onRunCommand', {
            name,
            opts,
        });

        return fn(args);
    }
}

module.exports = Service;
