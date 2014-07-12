//Retrieve command line arguments and store in variables
var WORKING_DIRECTORY = process.argv[2];
var SERVER = process.argv[3];
var BUILD_DIRECTORY = process.argv[4] || "/";
console.log("Build directory: " + BUILD_DIRECTORY);
//Include modules
var io = require('socket.io-client');
var btoa = require('btoa');
var fs = require('fs');
var walk = require('walk');
var crypto = require('crypto');
var path = require('path');
var http = require('http');
var url = require('url');
var ip = require('ip');
var btoa = require('btoa');
var watch = require('watch');

var PROJECT = btoa(WORKING_DIRECTORY);

//Change the working directory to the specified directory
process.chdir(WORKING_DIRECTORY);

//Connect to server
var socket = io.connect('http://' + SERVER, {
    'reconnection delay': 100,
    'reconnection limit': 100,
    'max reconnection attempts': Infinity
});
socket.on('connect', function(){
    connected();
    socket.on('buildresult', function(data){
        console.log (data.result);
        buildStatus['state'] = "idle";
        buildStatus['last_build_result'] = data.result;
    });
    socket.on('disconnect', function(){});
});

//Called once connected
function connected(){
    //Sync the working directory with the server
    sync();
}


function sync(){
    console.log("Syncing with remote");
    console.log("- Walking directory");

    // Walker options
    var walker  = walk.walk('./', { followLinks: false });
    var files   = [];
    // Loop through each file in the directory
    walker.on('file', function(root, stat, next) {
        //MD5 the files contents
        hashFile(root  + "/" + stat.name, function (hash){
            //Get the filepath relative to the working directory
            var filePath = path.relative(WORKING_DIRECTORY, root +  "/" + stat.name);
            //Send file information to server along with project name
            socket.emit('fileSync', {'path': filePath, 'hash': hash, 'project': PROJECT, 'server': ip.address()});
        });
        files.push(path.relative(WORKING_DIRECTORY, root +  "/" + stat.name).split("\\").join("/"));
        next();
    });

    walker.on('end', function() {
        console.log("Walking directory done");
        //Send file list to server
        socket.emit('fileList',{'files':files, 'project': PROJECT});
        if (watching == false){
        startWatch();
        }
    });
}

//MD5 hash a file
function hashFile(filename, callback){
    var fd = fs.createReadStream(filename);
    var hash = crypto.createHash('md5');
    hash.setEncoding('hex');

    fd.on('end', function() {
        hash.end();
        callback(hash.read());
    });

    fd.pipe(hash);
}

//Create HTTP file server
http.createServer(function(request, response) {
  var uri = url.parse(request.url).pathname
    , filename = decodeURI(path.join(process.cwd(), uri));
  fs.exists(filename, function(exists) {
    if(!exists) {
      response.writeHead(404, {"Content-Type": "text/plain"});
      response.write("404 Not Found\n");
      response.end();
      return;
    }
 
    fs.readFile(filename, "binary", function(err, file) {
      if(err) {        
        response.writeHead(500, {"Content-Type": "text/plain"});
        response.write(err + "\n");
        response.end();
        return;
      }
 
      response.writeHead(200);
      response.write(file, "binary");
      response.end();
    });
  });
}).listen(8888);

console.log("File server listening on " + ip.address());

var watching = false;
//Create directory watcher
function startWatch(){
    watching = true;
    console.log("Started watching directory");
    watch.createMonitor(WORKING_DIRECTORY, function (monitor) {
    monitor.on("created", function (f, stat) {
        // Check whether file or directory
        fs.stat(f, function (err, stat){
            if (stat.isFile()){
                syncFile(f);   
            }
        });
      
      console.log("Create: " + path.relative(WORKING_DIRECTORY, f));
    });
    monitor.on("changed", function (f, curr, prev) {
        // Check whether file or directory
        fs.stat(f, function (err, stat){
                if (stat.isFile()){
                    syncFile(f);   
                }
        });
        
        console.log("Changed: " + path.relative(WORKING_DIRECTORY, f));
    });
    monitor.on("removed", function (f, stat) {
      // Handle removed files
      console.log("Remove: " + path.relative(WORKING_DIRECTORY, f)); 
      // Tell server to delete file
      deleteFile(f);
    });
  });  
}


//Syncs a single file
function syncFile(filename){
    hashFile(filename, function (hash){
        //Get the filepath relative to the working directory
        var filePath = path.relative(WORKING_DIRECTORY, filename);
        //Send file information to server along with project name
        socket.emit('fileSync', {'path': filePath, 'hash': hash, 'project': PROJECT, 'server': ip.address()});
    });   
}

//Delete a file from the remote server
function deleteFile(filename){
     var filePath = path.relative(WORKING_DIRECTORY, filename);
        //Send file information to server along with project name
        socket.emit('fileDelete', {'path': filePath,'project': PROJECT});
}

var buildStatus = {};
buildStatus['state'] = "idle";
buildStatus['last_build_result'] = "";
buildStatus['last_build_time'] = 0;
//Create HTTP API server
http.createServer(function(request, response) {
  var uri = url.parse(request.url).pathname
    , filename = decodeURI(uri);
  if (filename == "/build"){
        //Tell server to do a build
        socket.emit('build',{'project':PROJECT, 'builddir' : BUILD_DIRECTORY});
        console.log("Building.....");
        buildStatus['state'] = 'building';
        buildStatus['last_build_time'] = (new Date).getTime();
  }
    if (filename == "/status"){
        response.write(JSON.stringify(buildStatus));   
    }
  response.end();
}).listen(8080);