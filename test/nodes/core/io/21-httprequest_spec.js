/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

var when = require("when");
var http = require("http");
var https = require("https");
var should = require("should");
var express = require("express");
var bodyParser = require('body-parser');
var stoppable = require('stoppable');
var helper = require("node-red-node-test-helper");
var httpRequestNode = require("../../../../nodes/core/io/21-httprequest.js");
var tlsNode = require("../../../../nodes/core/io/05-tls.js");
var hashSum = require("hash-sum");
var httpProxy = require('http-proxy');
var cookieParser = require('cookie-parser');
var RED = require("../../../../red/red.js");
var fs = require('fs-extra');
var auth = require('basic-auth');

describe('HTTP Request Node', function() {
    var testApp;
    var testServer;
    var testPort = 9000;
    var testSslServer;
    var testSslPort = 9100;
    var testProxyServer;
    var testProxyPort = 9200;

    //save environment variables
    var preEnvHttpProxyLowerCase;
    var preEnvHttpProxyUpperCase;
    var preEnvNoProxyLowerCase;
    var preEnvNoProxyUpperCase;

    function startServer(done) {
        testPort += 1;
        testServer = stoppable(http.createServer(testApp));
        testServer.listen(testPort,function(err) {
            testSslPort += 1;
            var sslOptions = {
                key:  fs.readFileSync('test/resources/ssl/server.key'),
                cert: fs.readFileSync('test/resources/ssl/server.crt')
                /*
                    Country Name (2 letter code) [AU]:
                    State or Province Name (full name) [Some-State]:
                    Locality Name (eg, city) []:
                    Organization Name (eg, company) [Internet Widgits Pty Ltd]:
                    Organizational Unit Name (eg, section) []:
                    Common Name (e.g. server FQDN or YOUR name) []:localhost
                    Email Address []:

                    Please enter the following 'extra' attributes to be sent with your certificate request
                    A challenge password []:
                    An optional company name []:
                */
            };
            testSslServer = stoppable(https.createServer(sslOptions,testApp));
            testSslServer.listen(testSslPort);

            testProxyPort += 1;
            testProxyServer = stoppable(httpProxy.createProxyServer({target:'http://localhost:' + testPort}));
            testProxyServer.on('proxyReq', function(proxyReq, req, res, options) {
                proxyReq.setHeader('x-testproxy-header', 'foobar');
            });
            testProxyServer.on('proxyRes', function (proxyRes, req, res, options) {
                if (req.url == getTestURL('/proxyAuthenticate')){
                    var user = auth.parse(req.headers['proxy-authorization']);
                    if (!(user.name == "foouser" && user.pass == "barpassword")){
                        proxyRes.headers['proxy-authenticate'] = 'BASIC realm="test"';
                        proxyRes.statusCode = 407;
                    }
                }
            });
            testProxyServer.listen(testProxyPort);
            done(err);
        });
    }

    function getTestURL(url) {
        return "http://localhost:"+testPort+url;
    }

    function getSslTestURL(url) {
        return "https://localhost:"+testSslPort+url;
    }

    function getSslTestURLWithoutProtocol(url) {
        return "localhost:"+testSslPort+url;
    }

    function saveProxySetting() {
        preEnvHttpProxyLowerCase = process.env.http_proxy;
        preEnvHttpProxyUpperCase = process.env.HTTP_PROXY;
        preEnvNoProxyLowerCase = process.env.no_proxy;
        preEnvNoProxyUpperCase = process.env.NO_PROXY;
        delete process.env.http_proxy;
        delete process.env.HTTP_PROXY;
        delete process.env.no_proxy;
        delete process.env.NO_PROXY;
    }

    function restoreProxySetting() {
        process.env.http_proxy = preEnvHttpProxyLowerCase;
        process.env.HTTP_PROXY = preEnvHttpProxyUpperCase;
        // On Windows, if environment variable of NO_PROXY that includes lower cases
        // such as No_Proxy is replaced with NO_PROXY.
        process.env.no_proxy = preEnvNoProxyLowerCase;
        process.env.NO_PROXY = preEnvNoProxyUpperCase;
        if (preEnvHttpProxyLowerCase == undefined){
            delete process.env.http_proxy;
        }
        if (preEnvHttpProxyUpperCase == undefined){
            delete process.env.HTTP_PROXY;
        }
        if (preEnvNoProxyLowerCase == undefined){
            delete process.env.no_proxy;
        }
        if (preEnvNoProxyUpperCase == undefined){
            delete process.env.NO_PROXY;
        }
    }

    before(function(done) {
        testApp = express();
        testApp.use(bodyParser.raw({type:"*/*"}));
        testApp.use(cookieParser());
        testApp.get('/statusCode204', function(req,res) { res.status(204).end();});
        testApp.get('/text', function(req, res){ res.send('hello'); });
        testApp.get('/redirectToText', function(req, res){ res.status(302).set('Location', getTestURL('/text')).end(); });
        testApp.get('/json-valid', function(req, res){ res.json({a:1}); });
        testApp.get('/json-invalid', function(req, res){ res.set('Content-Type', 'application/json').send("{a:1"); });
        testApp.get('/headersInspect', function(req, res){ res.set('x-test-header', 'bar').send("a"); });
        testApp.get('/timeout', function(req, res){
            setTimeout(function() {
                res.send('hello');
            }, 10000);
        });
        testApp.get('/checkCookie', function(req, res){
            var value = req.cookies.data;
            res.send(value);
        });
        testApp.get('/setCookie', function(req, res){
            res.cookie('data','hello');
            res.send("");
        });
        testApp.get('/authenticate', function(req, res){
            var user = auth.parse(req.headers['authorization']);
            var result = {
                user: user.name,
                pass: user.pass,
            };
            res.json(result);
        });
        testApp.get('/proxyAuthenticate', function(req, res){
            var user = auth.parse(req.headers['proxy-authorization']);
            var result = {
                user: user.name,
                pass: user.pass,
                headers: req.headers
            };
            res.json(result);
        });
        testApp.post('/postInspect', function(req,res) {
            var result = {
                body: req.body.toString(),
                headers: req.headers
            };
            res.json(result);
        });
        testApp.put('/putInspect', function(req,res) {
            var result = {
                body: req.body.toString(),
                headers: req.headers
            };
            res.json(result);
        });
        testApp.delete('/deleteInspect', function(req,res) { res.status(204).end();});
        testApp.head('/headInspect', function(req,res) { res.status(204).end();});
        testApp.patch('/patchInspect', function(req,res) {
            var result = {
                body: req.body.toString(),
                headers: req.headers
            };
            res.json(result);
        });
        testApp.trace('/traceInspect', function(req,res) {
            var result = {
                body: req.body.toString(),
                headers: req.headers
            };
            res.json(result);
        });
        testApp.options('/*', function(req,res) {
            res.status(200).end();
        });
        startServer(function(err) {
            if (err) {
                done(err);
            }
            helper.startServer(done);
        });
    });

    after(function(done) {
        testServer.stop(() => {
            testProxyServer.stop(() => {
                testSslServer.stop(() => {
                    helper.stopServer(done);
                });
            });
        });
    });

    afterEach(function() {
        helper.unload();
    });

    describe('request', function() {
        it('should get plain text content', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:getTestURL('/text')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-length',''+('hello'.length));
                        msg.headers.should.have.property('content-type').which.startWith('text/html');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should get JSON content', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/json-valid')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload',{a:1});
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-type').which.startWith('application/json');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should send the payload as the body of a POST as application/json', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload');
                        msg.payload.body.should.eql('{"foo":"abcde"}');
                        msg.payload.headers.should.have.property('content-type').which.startWith('application/json');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-type').which.startWith('application/json');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:{foo:"abcde"}});
            });
        });

        it('should send a payload of 0 as the body of a POST as text/plain', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload');
                        msg.payload.body.should.eql('0');
                        msg.payload.headers.should.have.property('content-length','1');
                        msg.payload.headers.should.have.property('content-type').which.startWith('text/plain');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:0, headers: { 'content-type': 'text/plain'}});
            });
        });

        it('should send an Object payload as the body of a POST', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload');
                        msg.payload.body.should.eql('{"foo":"abcde"}');
                        msg.payload.headers.should.have.property('content-type').which.startWith('text/plain');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-type').which.startWith('application/json');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:{foo:"abcde"}, headers: { 'content-type': 'text/plain'}});
            });
        });

        it('should send a Buffer as the body of a POST', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload');
                        msg.payload.body.should.eql('hello');
                        msg.payload.headers.should.have.property('content-type').which.startWith('text/plain');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-type').which.startWith('application/json');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:new Buffer('hello'), headers: { 'content-type': 'text/plain'}});
            });
        });

        it('should send form-based request', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.payload.body.should.equal("foo=1%202%203&bar=");
                        msg.payload.should.have.property('headers');
                        msg.payload.headers.should.have.property('content-type','application/x-www-form-urlencoded');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:{foo:'1 2 3', bar:''}, headers: { 'content-type': 'application/x-www-form-urlencoded'}});
            });
        });

        it('should send PUT request', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"PUT",ret:"obj",url:getTestURL('/putInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload');
                        msg.payload.body.should.eql('foo');
                        msg.payload.headers.should.have.property('content-type').which.startWith('text/plain');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-type').which.startWith('application/json');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", headers: { 'content-type': 'text/plain'}});
            });
        });

        it('should send DELETE request', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"DELETE",ret:"obj",url:getTestURL('/deleteInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','');
                        msg.should.have.property('statusCode',204);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:{foo:"abcde"}});
            });
        });

        it('should send HEAD request', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"use",ret:"txt",url:getTestURL('/headInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','');
                        msg.should.have.property('statusCode',204);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", method:"head"});
            });
        });

        it('should send PATCH request', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"PATCH",ret:"obj",url:getTestURL('/patchInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload');
                        msg.payload.body.should.eql('foo');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('etag');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", headers: { 'content-type': 'text/plain'}});
            });
        });

        it('should send OPTIONS request', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"use",ret:"obj",url:getTestURL('/*')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('statusCode',200);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", method:"options"});
            });
        });

        it('should send TRACE request', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"use",ret:"obj",url:getTestURL('/traceInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload');
                        msg.payload.body.should.eql('foo');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", method:"trace", headers: { 'content-type': 'text/plain'}});
            });
        });

        it('should get Buffer content', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"bin",url:getTestURL('/text')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload');
                        Buffer.isBuffer(msg.payload).should.be.true();
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-type');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should return plain text when JSON fails to parse', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/json-invalid')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload',"{a:1");
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-type').which.startWith('application/json');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should return the status code', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:getTestURL('/statusCode204')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','');
                        msg.should.have.property('statusCode',204);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should use msg.url', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/text')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", url:"/foo"});
            });
        });

        it('should output an error when URL is not provided', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:""},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                var inError = false;
                n2.on("input", function(msg) {
                    inError = true;
                });
                n1.receive({payload:"foo"});
                setTimeout(function() {
                    if (inError) {
                        done(new Error("no url allowed though"));
                    } else {
                        done();
                    }
                },20);
            });
        });

        it('should allow the message to provide the url', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt"},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-length',''+('hello'.length));
                        msg.headers.should.have.property('content-type').which.startWith('text/html');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo",url:getTestURL('/text')});
            });
        });

        it('should allow the url to contain mustache placeholders', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:getTestURL('/te{{placeholder}}')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-length',''+('hello'.length));
                        msg.headers.should.have.property('content-type').which.startWith('text/html');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo",placeholder:"xt"});
            });
        });

        it('should allow the url to be missing the http:// prefix', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:getTestURL('/text').substring("http://".length)},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-length',''+('hello'.length));
                        msg.headers.should.have.property('content-type').which.startWith('text/html');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should reject non http:// schemes - node config', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:"ftp://foo"},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                var inError = false;
                n2.on("input", function(msg) {
                    inError = true;
                });
                n1.receive({payload:"foo"});
                setTimeout(function() {
                    if (inError) {
                        done(new Error("non http(s):// scheme allowed through"));
                    } else {
                        done();
                    }
                },20);
            });
        });

        it('should reject non http:// schemes - msg.url', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt"},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                var inError = false;
                n2.on("input", function(msg) {
                    inError = true;
                });
                n1.receive({payload:"foo",url:"ftp://foo"});
                setTimeout(function() {
                    if (inError) {
                        done(new Error("non http(s):// scheme allowed through"));
                    } else {
                        done();
                    }
                },20);
            });
        });

        it('should use msg.method', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/text')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", method:"POST"});
            });
        });

        it('should allow the message to provide the method', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"use",ret:"txt",url:getTestURL('/text')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-length',''+('hello'.length));
                        msg.headers.should.have.property('content-type').which.startWith('text/html');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo",method:"get"});
            });
        });

        it('should receive msg.responseUrl', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:getTestURL('/text')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('responseUrl', getTestURL('/text'));
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should receive msg.responseUrl when redirected', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:getTestURL('/redirectToText')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('responseUrl', getTestURL('/text'));
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('shuold output an error when request timeout occurred', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/timeout')},
                {id:"n2", type:"helper"}];
            var timeout = RED.settings.httpRequestTimeout;
            RED.settings.httpRequestTimeout = 50;
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('statusCode','ECONNRESET');
                        done();
                    } catch(err) {
                        done(err);
                    } finally {
                        RED.settings.httpRequestTimeout = timeout;
                    }
                });
                n1.receive({payload:"foo"});
            });
        });
    });

    describe('HTTP header', function() {
        it('should receive cookie', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/setCookie')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.responseCookies.should.have.property('data');
                        msg.responseCookies.data.should.have.property('value','hello');
                        msg.should.have.property('statusCode',200);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should send cookie with string', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/checkCookie')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','abc');
                        msg.should.have.property('statusCode',200);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", cookies:{data:'abc'}});
            });
        });

        it('should send cookie with obejct data', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/checkCookie')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','abc');
                        msg.should.have.property('statusCode',200);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", cookies:{data:{value:'abc'}}});
            });
        });

        it('should send cookie by msg.headers', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/checkCookie')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','abc');
                        msg.should.have.property('statusCode',200);
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", cookies:{boo:'123'}, headers:{'cookie':'data=abc'}});
            });
        });

        it('should convert all HTTP headers into lower case', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.payload.should.have.property('headers');
                        msg.payload.headers.should.have.property('content-type').which.startWith('text/plain');
                        msg.payload.headers.should.have.property('content-length', "3");
                        msg.payload.headers.should.have.property('if-modified-since','Sun, 01 Jun 2000 00:00:00 GMT');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", headers: { 'Content-Type':'text/plain', 'Content-Length': "3", 'If-Modified-Since':'Sun, 01 Jun 2000 00:00:00 GMT'}});
            });
        });

        it('should receive HTTP header', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:getTestURL('/headersInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.headers.should.have.property('x-test-header','bar');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should ignore unmodified x-node-red-request-node header', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.payload.headers.should.have.property('content-type').which.startWith('application/json');
                        msg.payload.headers.should.not.have.property('x-node-red-request-node');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                // Pass in a headers property with an unmodified x-node-red-request-node hash
                // This should cause the node to ignore the headers
                n1.receive({payload:{foo:"bar"}, headers: { 'content-type': 'text/plain', "x-node-red-request-node":"67690139"}});
            });
        });

        it('should use modified msg.headers property', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    try {
                        msg.payload.headers.should.have.property('content-type').which.startWith('text/plain');
                        msg.payload.headers.should.not.have.property('x-node-red-request-node');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                // Pass in a headers property with a x-node-red-request-node hash that doesn't match the contents
                // This should cause the node to use the headers
                n1.receive({payload:{foo:"bar"}, headers: { 'content-type': 'text/plain', "x-node-red-request-node":"INVALID_SUM"}});
            });
        });
    });

    describe('protocol', function() {
        it('should use msg.rejectUnauthorized', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:getSslTestURL('/text')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n2 = helper.getNode("n2");
                var n1 = helper.getNode("n1");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-length',''+('hello'.length));
                        msg.headers.should.have.property('content-type').which.startWith('text/html');
                        msg.should.have.property('responseUrl').which.startWith('https://');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo", rejectUnauthorized: false});
            });
        });

        it('should use tls-config', function(done) {
            var flow = [
                {id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"txt",url:getSslTestURLWithoutProtocol('/text'),tls:"n3"},
                {id:"n2", type:"helper"},
                {id:"n3", type:"tls-config", cert:"test/resources/ssl/server.crt", key:"test/resources/ssl/server.key", ca:"", verifyservercert:false}];
            var testNodes = [httpRequestNode, tlsNode];
            helper.load(testNodes, flow, function() {
                var n3 = helper.getNode("n3");
                var n2 = helper.getNode("n2");
                var n1 = helper.getNode("n1");
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('payload','hello');
                        msg.should.have.property('statusCode',200);
                        msg.should.have.property('headers');
                        msg.headers.should.have.property('content-length',''+('hello'.length));
                        msg.headers.should.have.property('content-type').which.startWith('text/html');
                        msg.should.have.property('responseUrl').which.startWith('https://');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should use http_proxy', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            saveProxySetting();
            process.env.http_proxy = "http://localhost:" + testProxyPort;
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    restoreProxySetting();
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.payload.should.have.property('headers');
                        msg.payload.headers.should.have.property('x-testproxy-header','foobar');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should use http_proxy when environment variable is invalid', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            saveProxySetting();
            process.env.http_proxy = "invalidvalue";
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    restoreProxySetting();
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.payload.should.have.property('headers');
                        msg.payload.headers.should.not.have.property('x-testproxy-header','foobar');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should use HTTP_PROXY', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            saveProxySetting();
            process.env.HTTP_PROXY = "http://localhost:" + testProxyPort;
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    restoreProxySetting();
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.payload.should.have.property('headers');
                        msg.payload.headers.should.have.property('x-testproxy-header','foobar');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should use no_proxy', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            saveProxySetting();
            process.env.http_proxy = "http://localhost:" + testProxyPort;
            process.env.no_proxy = "foo,localhost";
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    restoreProxySetting();
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.payload.headers.should.not.have.property('x-testproxy-header','foobar');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should use NO_PROXY', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"POST",ret:"obj",url:getTestURL('/postInspect')},
                {id:"n2", type:"helper"}];
            saveProxySetting();
            process.env.HTTP_PROXY = "http://localhost:" + testProxyPort;
            process.env.NO_PROXY = "foo,localhost";
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    restoreProxySetting();
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.payload.headers.should.not.have.property('x-testproxy-header','foobar');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });
    });

    describe('authentication', function() {
        it('should authenticate on server', function(done) {
            var flow = [{id:"n1",type:"http request",wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/authenticate')},
                {id:"n2", type:"helper"}];
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n1.credentials = {user:'userfoo', password:'passwordfoo'};
                n2.on("input", function(msg) {
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.payload.should.have.property('user', 'userfoo');
                        msg.payload.should.have.property('pass', 'passwordfoo');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should authenticate on proxy server', function(done) {
            var flow = [{id:"n1",type:"http request", wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/proxyAuthenticate')},
                {id:"n2", type:"helper"}];
            saveProxySetting();
            process.env.http_proxy = "http://foouser:barpassword@localhost:" + testProxyPort;
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    restoreProxySetting();
                    try {
                        msg.should.have.property('statusCode',200);
                        msg.payload.should.have.property('user', 'foouser');
                        msg.payload.should.have.property('pass', 'barpassword');
                        msg.payload.should.have.property('headers');
                        msg.payload.headers.should.have.property('x-testproxy-header','foobar');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });

        it('should output an error when proxy authentication was failed', function(done) {
            var flow = [{id:"n1",type:"http request", wires:[["n2"]],method:"GET",ret:"obj",url:getTestURL('/proxyAuthenticate')},
                {id:"n2", type:"helper"}];
            saveProxySetting();
            process.env.http_proxy = "http://xxxuser:barpassword@localhost:" + testProxyPort;
            helper.load(httpRequestNode, flow, function() {
                var n1 = helper.getNode("n1");
                var n2 = helper.getNode("n2");
                n2.on("input", function(msg) {
                    restoreProxySetting();
                    try {
                        msg.should.have.property('statusCode',407);
                        msg.headers.should.have.property('proxy-authenticate', 'BASIC realm="test"');
                        msg.payload.should.have.property('headers');
                        msg.payload.headers.should.have.property('x-testproxy-header','foobar');
                        done();
                    } catch(err) {
                        done(err);
                    }
                });
                n1.receive({payload:"foo"});
            });
        });
    });
});
