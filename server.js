//Define variables
var APP_PORT = 2633;

//Load modules
var http = require('http');
var server = http.Server();
var io = require('socket.io')(server);
var fs = require("graceful-fs");
var path = require("path");
var ensureDir = require("ensureDir");
var crypto = require("crypto");
var walk = require("walk");
var downloading = [];
var exec = require("child_process").exec;

//Create projects directory
fs.mkdir('projects/', function (err){});

//Handle socket connection and events
io.on('connection', function(socket){
    console.log("Client Connected");
    socket.on('fileSync', function(data){
        downloading[data.project] = 0;
        //File sync requested
        fileSync(data);
    });
    socket.on('fileDelete', function (data){
        deleteFile(data);   
    });
    socket.on('fileList', function (data){
        checkFiles(data); 
    });
    socket.on('build', function (data){
       buildProject(data, function (result){
            socket.emit('buildresult', {'result': result});   
       }); 
    });
    socket.on('disconnect', function(){});
});

//Listen for requests
server.listen(APP_PORT);

function fileSync(data){
    //Check if the file exists
    var filePath = "projects/" + data.project + "/" + data.path;
    //Fix windows path issue
    filePath = filePath.split("\\").join("/");
    fs.exists(filePath, function (exists){
       if (exists){
            //File exists md5 contents and compare to what was sent
            hashFile(filePath, function (hash){
                //Compare hashes
                if (hash == data.hash){
                    //Hash matches, no need to request file
                } else {
                    //Hash doesn't match, download file from client
                    console.log("Downloading: " + data.path + " from " + data.server);
                    downloadFile("http://" + data.server + ":8888/" + data.path, data.project, data.path);
                }
            });
       } else {
            //File doesn't exist, download file from client
            console.log("Downloading: " + data.path + " from " + data.server);
            downloadFile("http://" + data.server + ":8888/" + data.path, data.project, data.path);
       }
    });
}

function hashFile(filename, callback){
    filename = filename.split("\\").join("/");
    var fd = fs.createReadStream(filename);
    var hash = crypto.createHash('md5');
    hash.setEncoding('hex');
    
    fd.on('end', function (){
        hash.end();
        callback(hash.read());
    });
    
    fd.pipe(hash);
}

var execCount = 0;

//Downloads a file from the client at the specified url
function downloadFile(url, project, filename, callback){
    var filePath = "projects/" + project + "/" + filename;
    //Fix windows path issue
    filePath = filePath.split("\\").join("/");
    ensureDir(path.dirname(filePath), 0777, function (){
        var file = fs.createWriteStream(filePath);
        file.on('open', function (fd){
            var request = http.get(url, function(response) {
                if (response.statusCode == 200){
                    response.pipe(file);
                    console.log("File: " + filename + " synced");
                } else {
                    console.log("Error retrieving file: " + filename); 
                }
            });
        });
    });
    
  
}

//Delete a file 
function deleteFile(data){
    var filePath = "projects/" + data.project + "/" + data.path;
    //Fix windows path issue
    filePath = filePath.split("\\").join("/");
    fs.unlink(filePath, function (err){
        if (!err){
            console.log("File: " + data.path + " deleted");   
        } else {
            console.log(err);   
        }
    });
}

//Checks for any files which have been deleted when the client software wasn't running / offline
function checkFiles(data){
    var clientList = data.files;
    //Walk the project directory on the server
    var walk    = require('walk');

    // Walker options
    var walker  = walk.walk('projects/' + data.project + "/", { followLinks: false });

    walker.on('file', function(root, stat, next) {
        //Check whether file on client list
        var filePath = path.relative( process.cwd() + "/projects/" + data.project, root + "/" +stat.name);
        if (clientList.indexOf(filePath) < 0){
            //File non existant on client, delete from project
            fs.unlink("projects/" + data.project + "/" + filePath, function (err){
                if (err){   
                    console.log(err);
                }
            });
        }
        next();
    });

    walker.on('end', function() {
        console.log("Remote sync complete");
    });
}

function buildProject(data, callback){
    var done = false;
    console.log("Building.....");
    var path = "projects/" + data.project + "/" + data.builddir; 
    //Fix windows path issue
    path = path.split("\\").join("/");
    exec("cd " + path + ";xcodebuild > " + process.cwd() + "/projects/" + data.project + ".buildlog 2>&1", function (error, stdout, stderr){
        //Build complete - find result from log file
        fs.readFile(process.cwd() + "/projects/" + data.project + ".buildlog", function (err, data) {
            if (data.toString().indexOf("** BUILD SUCCEEDED **") > -1){
                //Build passed
                console.log("Build Passed");
                if (done == false){
                callback("Build Passed");
                    done = true;
                }
            } else {
                //Build failed
                if (done == false){
                console.log("Build Failed");
                callback("Build Failed");
                 done = true;   
                }
            }
        });
        
    });
};