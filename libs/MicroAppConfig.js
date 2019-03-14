'use strict';

const path = require('path');
const fs = require('fs');
const symbols = require('../config/symbols');

const NODE_MODULES = 'node_modules';
const PACKAGE_JSON = 'package.json';

const INIT = Symbol('MicroAppConfig_INIT');

class MicroAppConfig {

    constructor(config) {
        this[INIT](config);
        this._config = config || {};
    }

    [INIT](config) {
        if (config) {
            try {
                const packagePath = path.join(config[symbols.root], PACKAGE_JSON);
                if (fs.existsSync(packagePath)) {
                    this._packagePath = packagePath;
                    this._package = require(packagePath);
                }
            } catch (error) {
                this._packagePath = '';
                this._package = {};
            }
        }
    }

    get config() {
        return this._config || {};
    }

    get packagePath() {
        return this._packagePath;
    }

    get package() {
        return Object.freeze(this._package);
    }

    get name() {
        const config = this.config;
        return config.name || this.package.name || '';
    }

    get version() {
        const config = this.config;
        return config.version || this.package.version || '';
    }

    get description() {
        const config = this.config;
        return config.description || this.package.description || '';
    }

    get type() {
        const config = this.config;
        return config.type || '';
    }

    get webpack() {
        const config = this.config;
        return config.webpack || {};
    }

    get micros() {
        const config = this.config;
        if (config.micros && Array.isArray(config.micros)) {
            return [ ...new Set(config.micros) ];
        }
        return [];
    }

    get microsExtral() {
        const config = this.config;
        const result = {};
        this.micros.forEach(micro => {
            result[micro] = Object.assign({}, config[`micros$$${micro}`] || {
                disabled: false, // 禁用入口
                disable: false,
            });
        });
        return result;
    }

    get root() {
        const config = this.config;
        return config[symbols.root] || '';
    }

    get path() {
        const config = this.config;
        return config[symbols.path] || '';
    }

    get nodeModules() {
        if (this.root) {
            return path.join(this.root, NODE_MODULES);
        }
        return '';
    }

    // 后端共享
    get shared() {
        const config = this.config;
        if (config) {
            return config.shared || config.share || {};
        }
        return {};
    }

    // 前端共享
    get alias() {
        const config = this.config;
        return config.alias || {};
    }

    // server
    get server() {
        const config = this.config;
        return config.server || {};
    }

    toJSON(simple = false) {
        const json = {
            name: this.name,
            version: this.version,
            type: this.type,
            description: this.description,
            root: this.root,
        };
        if (!simple) {
            json.micros = this.micros;
        }
        return json;
    }
}

module.exports = MicroAppConfig;
